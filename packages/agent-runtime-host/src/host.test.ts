import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST_METHODS, JsonRpcPeer, type PeerStreams, type RuntimeEvent } from "@aether/agent-contracts";
import { AetherHost } from "./host.js";

/**
 * Drive a real AetherHost over in-memory JSON-RPC streams with a fake
 * runtime registered through a test subclass seam (registry injection).
 */
import type { RuntimeDescriptor } from "./registry.js";

class TestHost extends AetherHost {
  constructor(descriptor: RuntimeDescriptor) {
    super({});
    // Replace the default registry with one containing a scripted adapter.
    const registryField = this as unknown as { registry: { register(d: RuntimeDescriptor): void } };
    registryField.registry.register(descriptor);
  }
}

function makeFakeAdapter() {
  const listeners = new Set<(ev: RuntimeEvent) => void>();
  const created: unknown[] = [];
  const runs: unknown[] = [];
  const approvals: unknown[] = [];
  return {
    listeners,
    created,
    runs,
    approvals,
    runtimeId: "fake",
    backendId: "fake-local",
    async getInfo() {
      return { runtimeId: "fake", name: "Fake", version: "1", description: "test" };
    },
    async getCapabilities() {
      return {
        plan: true, shell: true, files: true, mcp: false, subAgent: false,
        approval: true, steer: false, fork: false, interrupt: true, reasoning: false,
      };
    },
    async connect() {},
    async disconnect() {},
    async listThreads() {
      return [{ externalThreadId: "ext_1", title: "Old", updatedAt: new Date().toISOString(), runtimeId: "fake" }];
    },
    async createThread(req: unknown) {
      created.push(req);
      return { externalThreadId: "ext_new" };
    },
    async readThread(id: string) {
      return {
        externalThreadId: id,
        title: "Snapshot",
        items: [
          { id: "i1", threadId: "th_1", createdAt: new Date().toISOString(), type: "user_message", text: "hi" },
        ],
        lastSequence: 5,
      };
    },
    async startRun(req: unknown) {
      runs.push(req);
      const r = req as { threadId: string; runId: string };
      // Scripted async event stream with an approval.
      queueMicrotask(() => {
        for (const l of listeners) {
          l({
            eventId: "evt_1", sequence: 1, timestamp: new Date().toISOString(),
            runtimeId: "fake", backendId: "fake-local", threadId: r.threadId,
            runId: r.runId, type: "run.started", payload: { runId: r.runId },
          } as RuntimeEvent);
        }
        for (const l of listeners) {
          l({
            eventId: "evt_2", sequence: 2, timestamp: new Date().toISOString(),
            runtimeId: "fake", backendId: "fake-local", threadId: r.threadId,
            runId: r.runId, type: "approval.requested",
            payload: {
              approvalId: "apr_1", threadId: r.threadId, runId: r.runId,
              runtimeId: "fake", backendId: "fake-local", kind: "command",
              title: "Run command", detail: "rm -rf x", risk: "high",
              createdAt: new Date().toISOString(),
            },
          } as RuntimeEvent);
        }
      });
    },
    async interruptRun() {},
    async respondApproval(res: unknown) {
      approvals.push(res);
    },
    subscribe(listener: (ev: RuntimeEvent) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose() {},
  };
}

describe("AetherHost", () => {
  let dir: string;
  let host: TestHost;
  let clientPeer: JsonRpcPeer;
  let fake: ReturnType<typeof makeFakeAdapter>;
  const notifications: Array<{ method: string; params: unknown }> = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aether-host-"));
    await writeFile(path.join(dir, "hello.txt"), "hi from host test");

    fake = makeFakeAdapter();
    host = new TestHost({
      runtimeId: "fake",
      backendId: "fake-local",
      name: "Fake",
      description: "fake runtime",
      factory: () => fake as never,
      runtimeCapabilities: {
        plan: true, shell: true, files: true, mcp: false, subAgent: false,
        approval: true, steer: false, fork: false, interrupt: true, reasoning: false,
      },
      backendCapabilities: {
        backgroundRun: false, persistentWorkspace: true, remoteTerminal: false,
        browser: false, fileSync: true, artifactDownload: false,
      },
    });

    // Wire host to an in-memory client peer.
    let hostData: ((line: string) => void) | undefined;
    let clientData: ((line: string) => void) | undefined;
    const hostStreams: PeerStreams = {
      write: (s) => {
        for (const line of s.split("\n")) if (line.trim()) clientData?.(line);
      },
      onData: (cb) => {
        hostData = cb;
      },
      onClose: () => {},
    };
    clientPeer = new JsonRpcPeer({
      write: (s) => {
        for (const line of s.split("\n")) if (line.trim()) hostData?.(line);
      },
      onData: (cb) => {
        clientData = cb;
      },
      onClose: () => {},
    });
    clientPeer.onNotification((method, params) => notifications.push({ method, params }));
    await host.start({ stdio: hostStreams, socketPath: null, sessionFile: null });
  });

  afterAll(async () => {
    await host.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("pings", async () => {
    const res = (await clientPeer.request(HOST_METHODS.ping)) as { ok: boolean };
    expect(res.ok).toBe(true);
  });

  it("lists runtimes including registered fake", async () => {
    const res = (await clientPeer.request(HOST_METHODS.listRuntimes)) as {
      runtimes: Array<{ runtimeId: string; backendId: string }>;
    };
    const ids = res.runtimes.map((r) => `${r.runtimeId}:${r.backendId}`);
    expect(ids).toContain("codex:codex-local");
    expect(ids).toContain("deepseek:deepseek-local");
    expect(ids).toContain("fake:fake-local");
  });

  it("resolves effective capabilities", async () => {
    const res = (await clientPeer.request(HOST_METHODS.capabilities, {
      runtimeId: "fake",
      backendId: "fake-local",
    })) as { effective: { shell: boolean; steer: boolean } };
    expect(res.effective.shell).toBe(true);
    expect(res.effective.steer).toBe(false);
  });

  it("creates workspace and serves fs through the provider", async () => {
    const { workspace } = (await clientPeer.request(HOST_METHODS.createWorkspace, {
      name: "Test",
      rootPath: dir,
    })) as { workspace: { id: string } };
    expect(workspace.id).toMatch(/^ws_/);

    const list = (await clientPeer.request(HOST_METHODS.fsList, {
      workspaceId: workspace.id,
      path: ".",
    })) as { entries: Array<{ name: string }> };
    expect(list.entries.map((e) => e.name)).toContain("hello.txt");

    const read = (await clientPeer.request(HOST_METHODS.fsRead, {
      workspaceId: workspace.id,
      path: "hello.txt",
    })) as { content: { content: string } };
    expect(read.content.content).toBe("hi from host test");

    await clientPeer.request(HOST_METHODS.fsWrite, {
      workspaceId: workspace.id,
      path: "written.txt",
      content: "written by host",
    });
    const read2 = (await clientPeer.request(HOST_METHODS.fsRead, {
      workspaceId: workspace.id,
      path: "written.txt",
    })) as { content: { content: string } };
    expect(read2.content.content).toBe("written by host");
  });

  it("thread create -> run start -> events flow with sequences -> approval round trip", async () => {
    const { thread } = (await clientPeer.request(HOST_METHODS.createThread, {
      threadId: "th_1",
      runtimeId: "fake",
      backendId: "fake-local",
      cwd: dir,
    })) as { thread: { id: string; externalThreadId: string } };
    expect(thread.externalThreadId).toBe("ext_new");

    await clientPeer.request(HOST_METHODS.startRun, {
      threadId: "th_1",
      runtimeId: "fake",
      backendId: "fake-local",
      externalThreadId: thread.externalThreadId,
      runId: "run_1",
      text: "do something",
    });

    // Wait for notifications.
    const deadline = Date.now() + 5000;
    while (
      !notifications.some((n) => n.method === "runtimeEvent" && (n.params as RuntimeEvent).type === "approval.requested") &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const events = notifications
      .filter((n) => n.method === "runtimeEvent")
      .map((n) => n.params as RuntimeEvent);
    expect(events.map((e) => e.type)).toEqual(["run.started", "approval.requested"]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);

    // Approval side-channel arrived and is listed as pending.
    expect(notifications.some((n) => n.method === "approvalRequested")).toBe(true);
    const pending = (await clientPeer.request(HOST_METHODS.listPendingApprovals)) as {
      approvals: Array<{ approvalId: string }>;
    };
    expect(pending.approvals.map((a) => a.approvalId)).toContain("apr_1");

    await clientPeer.request(HOST_METHODS.respondApproval, {
      approvalId: "apr_1",
      decision: "approved_once",
    });
    // The fake adapter recorded the decision and the pending list cleared.
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.approvals).toHaveLength(1);
    expect((fake.approvals[0] as { decision: string }).decision).toBe("approved_once");
    const pendingAfter = (await clientPeer.request(HOST_METHODS.listPendingApprovals)) as {
      approvals: unknown[];
    };
    expect(pendingAfter.approvals).toHaveLength(0);
  });

  it("reads thread snapshots through the adapter", async () => {
    const res = (await clientPeer.request(HOST_METHODS.readThread, {
      threadId: "th_1",
      runtimeId: "fake",
      backendId: "fake-local",
      externalThreadId: "ext_new",
    })) as { items: Array<{ type: string }>; lastSequence: number };
    expect(res.items[0].type).toBe("user_message");
    expect(res.lastSequence).toBe(5);
  });

  it("creates terminals and relays output", async () => {
    const { workspace } = (await clientPeer.request(HOST_METHODS.createWorkspace, {
      name: "W2",
      rootPath: dir,
    })) as { workspace: { id: string } };
    const { terminalId } = (await clientPeer.request(HOST_METHODS.terminalCreate, {
      workspaceId: workspace.id,
    })) as { terminalId: string };
    expect(terminalId).toMatch(/^term_/);

    await clientPeer.request(HOST_METHODS.terminalWrite, {
      terminalId,
      data: "echo HOST_TERM_OK\r",
    });
    const deadline = Date.now() + 8000;
    while (
      !notifications.some(
        (n) => n.method === "terminalOutput" && String((n.params as { data: string }).data).includes("HOST_TERM_OK"),
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const out = notifications.find(
      (n) => n.method === "terminalOutput" && String((n.params as { data: string }).data).includes("HOST_TERM_OK"),
    );
    expect(out).toBeDefined();

    await clientPeer.request(HOST_METHODS.terminalDispose, { terminalId });
  });

  it("saves, lists and reads artifacts", async () => {
    const { artifact } = (await clientPeer.request(HOST_METHODS.artifactSave, {
      threadId: "th_1",
      title: "Report.md",
      type: "markdown",
      content: "# hello",
    })) as { artifact: { id: string } };
    const list = (await clientPeer.request(HOST_METHODS.artifactList, { threadId: "th_1" })) as {
      artifacts: Array<{ id: string }>;
    };
    expect(list.artifacts.map((a) => a.id)).toContain(artifact.id);
    const read = (await clientPeer.request(HOST_METHODS.artifactRead, {
      artifactId: artifact.id,
    })) as { content: string };
    expect(read.content).toBe("# hello");
  });
});
