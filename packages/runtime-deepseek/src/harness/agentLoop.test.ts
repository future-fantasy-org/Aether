import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTurn, type ApprovalAsk, type LoopContext } from "./agentLoop.js";
import { SessionStore } from "./sessions.js";
import type { StreamResult } from "./deepseekClient.js";

let dir: string;
let sessionsDir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aether-loop-"));
  await writeFile(path.join(dir, "a.txt"), "hello world");
  sessionsDir = path.join(dir, "sessions");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface RecordedEvent {
  type: string;
  payload: unknown;
}

function makeCtx(overrides: Partial<LoopContext> = {}): {
  ctx: LoopContext;
  events: RecordedEvent[];
  decisions: Array<ApprovalAsk["kind"]>;
} {
  const events: RecordedEvent[] = [];
  const decisions: ApprovalAsk["kind"][] = [];
  const ctx: LoopContext = {
    runId: "run_1",
    cwd: dir,
    model: "deepseek-chat",
    approvalMode: "askDangerous",
    apiKey: "k",
    baseUrl: "http://unused",
    emit: (type, payload) => events.push({ type, payload }),
    requestApproval: async (ask) => {
      decisions.push(ask.kind);
      return "approved_once";
    },
    interrupted: () => false,
    ...overrides,
  };
  return { ctx, events, decisions };
}

const plainReply = (text: string): StreamResult => ({
  content: text,
  reasoning: "",
  toolCalls: [],
  finishReason: "stop",
});

const toolReply = (name: string, args: Record<string, unknown>): StreamResult => ({
  content: "",
  reasoning: "",
  toolCalls: [{ id: "call_1", name, arguments: JSON.stringify(args) }],
  finishReason: "tool_calls",
});

describe("runTurn", () => {
  it("streams a plain text reply to completion", async () => {
    const { ctx, events } = makeCtx({
      stream: async (_c, _m, _t, handlers) => {
        handlers.onContentDelta("Hel");
        handlers.onContentDelta("lo");
        return plainReply("Hello");
      },
    });
    const store = new SessionStore("s_plain", sessionsDir);
    await store.hydrate();
    await runTurn(ctx, store, "say hi");
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("message.delta");
    expect(types).toContain("message.completed");
    expect(types.at(-1)).toBe("run.completed");
    expect(store.chatMessages().map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("executes read_file tool then finishes", async () => {
    const script = [toolReply("read_file", { path: "a.txt" }), plainReply("The file says hello world")];
    let call = 0;
    const { ctx, events } = makeCtx({
      stream: async () => script[Math.min(call++, script.length - 1)],
    });
    const store = new SessionStore("s_tool", sessionsDir);
    await store.hydrate();
    await runTurn(ctx, store, "read a.txt");
    const types = events.map((e) => e.type);
    expect(types).toContain("tool.started");
    const completed = events.find((e) => e.type === "tool.completed");
    expect((completed?.payload as { output: string }).output).toContain("hello world");
    expect(types.at(-1)).toBe("run.completed");
    // conversation: user, assistant(tool_calls), tool, assistant
    expect(store.chatMessages().map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("routes dangerous shell commands through approval", async () => {
    let approvalAsked = false;
    const script = [
      toolReply("run_shell", { command: "rm -rf /tmp/whatever" }),
      plainReply("done"),
    ];
    let call = 0;
    const { ctx, events } = makeCtx({
      approvalMode: "askDangerous",
      stream: async () => script[Math.min(call++, script.length - 1)],
      requestApproval: async (ask) => {
        approvalAsked = true;
        expect(ask.risk).toBe("high");
        expect(ask.detail).toContain("rm -rf");
        return "approved_once";
      },
    });
    const store = new SessionStore("s_appr", sessionsDir);
    await store.hydrate();
    await runTurn(ctx, store, "clean tmp");
    expect(approvalAsked).toBe(true);
    // approval.requested/resolved events are emitted by the server's
    // requestApproval wrapper (covered in e2e); here we verify the loop
    // honors the gate and proceeds after approval.
    expect(events.map((e) => e.type)).toContain("command.started");
    expect(events.map((e) => e.type)).toContain("command.completed");
    expect(types(events).at(-1)).toBe("run.completed");
  });

  it("rejected approval feeds a tool error back to the model", async () => {
    const script = [toolReply("run_shell", { command: "rm -rf /tmp/x" }), plainReply("ok, skipped")];
    let call = 0;
    const { ctx, events } = makeCtx({
      stream: async () => script[Math.min(call++, script.length - 1)],
      requestApproval: async () => "rejected",
    });
    const store = new SessionStore("s_rej", sessionsDir);
    await store.hydrate();
    await runTurn(ctx, store, "clean");
    const completed = events.find((e) => e.type === "tool.completed");
    expect((completed?.payload as { output: string }).output).toContain("rejected");
    const toolMsg = store.chatMessages().find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("rejected");
  });

  it("read-only shell commands skip approval", async () => {
    let asked = false;
    const script = [toolReply("run_shell", { command: "ls" }), plainReply("listed")];
    let call = 0;
    const { ctx } = makeCtx({
      stream: async () => script[Math.min(call++, script.length - 1)],
      requestApproval: async () => {
        asked = true;
        return "approved_once";
      },
    });
    const store = new SessionStore("s_readonly", sessionsDir);
    await store.hydrate();
    await runTurn(ctx, store, "list files");
    expect(asked).toBe(false);
  });

  it("emits run.cancelled when interrupted", async () => {
    const { ctx, events } = makeCtx({
      interrupted: () => true,
      stream: async () => plainReply("never"),
    });
    const store = new SessionStore("s_int", sessionsDir);
    await store.hydrate();
    await runTurn(ctx, store, "go");
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.cancelled"]);
  });

  it("emits run.failed on stream errors", async () => {
    const { ctx, events } = makeCtx({
      stream: async () => {
        throw new Error("boom");
      },
    });
    const store = new SessionStore("s_fail", sessionsDir);
    await store.hydrate();
    await runTurn(ctx, store, "go");
    expect(types(events)).toEqual(["run.started", "run.failed"]);
    expect((events[1].payload as { message: string }).message).toBe("boom");
  });

  it("emits filechange.detected for writes", async () => {
    const script = [
      toolReply("write_file", { path: "new-file.txt", content: "x" }),
      plainReply("written"),
    ];
    let call = 0;
    const { ctx, events } = makeCtx({
      stream: async () => script[Math.min(call++, script.length - 1)],
    });
    const store = new SessionStore("s_write", sessionsDir);
    await store.hydrate();
    await runTurn(ctx, store, "write");
    const fc = events.find((e) => e.type === "filechange.detected");
    expect(fc?.payload).toMatchObject({ path: "new-file.txt", changeType: "added" });
  });

  it("fails fast without an API key", async () => {
    const { ctx, events } = makeCtx({ apiKey: "", stream: async () => plainReply("x") });
    const store = new SessionStore("s_nokey", sessionsDir);
    await store.hydrate();
    await runTurn(ctx, store, "go");
    const failed = events.find((e) => e.type === "run.failed");
    expect((failed?.payload as { message: string }).message).toContain("API key");
  });
});

const types = (events: RecordedEvent[]): string[] => events.map((e) => e.type);
