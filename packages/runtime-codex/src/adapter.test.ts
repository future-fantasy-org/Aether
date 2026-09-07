import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./adapter.js";
import { JsonRpcPeer, type PeerStreams, type RuntimeEvent } from "@aether/agent-contracts";

/**
 * Scripted fake `codex app-server`: an in-memory JsonRpcPeer wired directly
 * to the adapter (no real process). Replays a full turn with an approval.
 */
function makeFakeServer() {
  let adapterData: ((line: string) => void) | undefined;
  let serverData: ((line: string) => void) | undefined;
  let approvalHandler: ((method: string, params: unknown) => Promise<unknown>) | undefined;

  const adapterStreams: PeerStreams = {
    write: (s) => {
      for (const line of s.split("\n")) if (line.trim()) serverData?.(line);
    },
    onData: (cb) => {
      adapterData = cb;
    },
    onClose: () => {},
  };

  const server = new JsonRpcPeer({
    write: (s) => {
      for (const line of s.split("\n")) if (line.trim()) adapterData?.(line);
    },
    onData: (cb) => {
      serverData = cb;
    },
    onClose: () => {},
  });

  server.onRequest((method, params) => {
    if (method.startsWith("item/") && method.endsWith("/requestApproval")) {
      if (approvalHandler) return approvalHandler(method, params);
      return Promise.resolve("accept");
    }
    if (method === "initialize") return Promise.resolve({});
    if (method === "thread/start") return Promise.resolve({ thread: { id: "codex_th_1" } });
    if (method === "thread/read") {
      return Promise.resolve({
        thread: {
          preview: "My thread",
          turns: [
            {
              items: [
                { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] },
                { type: "agentMessage", id: "m1", text: "Working" },
              ],
            },
          ],
        },
      });
    }
    if (method === "turn/interrupt") return Promise.resolve({});
    if (method === "turn/start") {
      setTimeout(() => {
        server.notify("turn/started", { threadId: "codex_th_1", turn: { id: "turn_1" } });
        server.notify("item/agentMessage/delta", {
          threadId: "codex_th_1",
          turnId: "turn_1",
          itemId: "m1",
          delta: "Working",
        });
        server.notify("item/started", {
          threadId: "codex_th_1",
          turnId: "turn_1",
          item: { type: "commandExecution", id: "c1", command: "rm -rf build", status: "inProgress" },
        });
      }, 10);
      return Promise.resolve({ turn: { id: "turn_1" } });
    }
    return Promise.reject(new Error(`fake server: no handler for ${method}`));
  });

  return {
    server,
    adapterStreams,
    setApprovalHandler(h: (method: string, params: unknown) => Promise<unknown>): void {
      approvalHandler = h;
    },
  };
}

describe("CodexAdapter against scripted fake app-server", () => {
  it("runs a full turn with streaming, approval round-trip and snapshot read", async () => {
    const { server, adapterStreams } = makeFakeServer();
    const adapter = new CodexAdapter();
    // Inject the fake peer instead of spawning `codex`.
    (adapter as unknown as { transport: { usePeerStreams(s: PeerStreams): void } }).transport.usePeerStreams(adapterStreams);

    const events: RuntimeEvent[] = [];
    adapter.subscribe((ev) => events.push(ev));

    const { externalThreadId } = await adapter.createThread({
      threadId: "th_1",
      cwd: "/tmp",
      approvalMode: "askDangerous",
    });
    expect(externalThreadId).toBe("codex_th_1");

    await adapter.startRun({
      threadId: "th_1",
      externalThreadId,
      runId: "run_1",
      text: "clean the build dir",
    });

    // Let the scripted turn play out, then trigger the approval + completion.
    await new Promise((r) => setTimeout(r, 50));
    // Approval is a server->client request; the test acts as the user by
    // calling respondApproval, which resolves the deferred rpc response.
    const approvalRpc = server.request("item/commandExecution/requestApproval", {
      threadId: "codex_th_1",
      turnId: "turn_1",
      itemId: "c1",
      command: { command: "rm -rf build" },
    }) as Promise<string>;

    // Wait for the adapter to surface approval.requested, then approve.
    const approvalDeadline = Date.now() + 3000;
    while (
      !events.some((e) => e.type === "approval.requested") &&
      Date.now() < approvalDeadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const approvalEv2 = events.find((e) => e.type === "approval.requested");
    const approvalRequest = approvalEv2?.payload as { approvalId: string };
    await adapter.respondApproval({
      approvalId: approvalRequest.approvalId,
      decision: "approved_once",
      raw: approvalEv2!.payload as never,
    });
    await expect(approvalRpc).resolves.toBe("accept");
    await new Promise((r) => setTimeout(r, 20));
    server.notify("item/completed", {
      threadId: "codex_th_1",
      turnId: "turn_1",
      item: { type: "commandExecution", id: "c1", command: "rm -rf build", status: "completed" },
    });
    server.notify("item/completed", {
      threadId: "codex_th_1",
      turnId: "turn_1",
      item: { type: "agentMessage", id: "m1", text: "Working" },
    });
    server.notify("turn/completed", { threadId: "codex_th_1", turn: { id: "turn_1", status: "completed" } });

    const deadline = Date.now() + 5000;
    while (!events.some((e) => e.type === "run.completed") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("thread.started");
    expect(types).toContain("run.started");
    expect(types).toContain("message.delta");
    expect(types).toContain("command.started");
    expect(types).toContain("command.completed");
    expect(types).toContain("message.completed");
    expect(types).toContain("run.completed");

    expect(types).toContain("approval.requested");
    const approvalEv = events.find((e) => e.type === "approval.requested");
    expect(approvalEv?.payload).toMatchObject({ kind: "command", risk: "high", threadId: "th_1" });
    expect(types).toContain("approval.resolved");

    const runStarted = events.find((e) => e.type === "run.started");
    expect(runStarted?.runId).toBe("run_1");
    const cmdCompleted = events.find((e) => e.type === "command.completed");
    expect(cmdCompleted?.runId).toBe("run_1");

    const snap = await adapter.readThread(externalThreadId);
    expect(snap.title).toBe("My thread");
    expect(snap.items.map((i) => i.type)).toEqual(["user_message", "agent_message"]);

    adapter.dispose();
  });
});
