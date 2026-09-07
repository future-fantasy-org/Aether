import { describe, expect, it } from "vitest";
import type { ApprovalRequest, RuntimeEvent } from "@aether/agent-contracts";
import { emptyProjection } from "./state.js";
import { projectEvent } from "./projectEvent.js";
import { projectSnapshot } from "./projectSnapshot.js";

let seq = 0;
const ev = (
  type: RuntimeEvent["type"],
  payload: unknown,
  overrides: Partial<RuntimeEvent> = {},
): RuntimeEvent => ({
  eventId: `evt_${++seq}`,
  sequence: seq,
  timestamp: new Date().toISOString(),
  runtimeId: "test",
  backendId: "test-local",
  threadId: "th_1",
  runId: "run_1",
  type,
  payload,
  ...overrides,
});

describe("projectEvent", () => {
  it("merges streaming message deltas into one item", () => {
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("message.delta", { itemId: "m1", delta: "Hello" }));
    p = projectEvent(p, ev("message.delta", { itemId: "m1", delta: " world" }));
    expect(p.items).toHaveLength(1);
    const item = p.items[0] as { type: string; text: string; streaming: boolean };
    expect(item.type).toBe("agent_message");
    expect(item.text).toBe("Hello world");
    expect(item.streaming).toBe(true);
  });

  it("finalizes message on completed", () => {
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("message.delta", { itemId: "m1", delta: "partial" }));
    p = projectEvent(p, ev("message.completed", { itemId: "m1", text: "final text" }));
    const item = p.items[0] as { text: string; streaming: boolean };
    expect(item.text).toBe("final text");
    expect(item.streaming).toBe(false);
  });

  it("creates reasoning summary from deltas", () => {
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("reasoning.delta", { itemId: "r1", delta: "thinking " }));
    p = projectEvent(p, ev("reasoning.delta", { itemId: "r1", delta: "hard" }));
    p = projectEvent(p, ev("reasoning.completed", { itemId: "r1", text: "done thinking" }));
    const item = p.items[0] as { type: string; text: string };
    expect(item.type).toBe("reasoning_summary");
    expect(item.text).toBe("done thinking");
  });

  it("drops events with stale sequence", () => {
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("message.delta", { itemId: "m1", delta: "a" }));
    const lastSeq = p.lastSequence;
    const stale = ev("message.delta", { itemId: "m2", delta: "b" });
    stale.sequence = lastSeq - 1;
    p = projectEvent(p, stale);
    expect(p.items).toHaveLength(1);
    expect((p.items[0] as { text: string }).text).toBe("a");
  });

  it("builds command item lifecycle: started -> output -> completed(0)", () => {
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("command.started", { itemId: "c1", command: "npm test" }));
    p = projectEvent(p, ev("command.output", { itemId: "c1", delta: "138 passed" }));
    p = projectEvent(p, ev("command.completed", { itemId: "c1", exitCode: 0 }));
    const item = p.items[0] as {
      type: string; command: string; output: string; exitCode?: number; status: string;
    };
    expect(item.type).toBe("command");
    expect(item.command).toBe("npm test");
    expect(item.output).toBe("138 passed");
    expect(item.exitCode).toBe(0);
    expect(item.status).toBe("completed");
  });

  it("marks command failed on non-zero exit", () => {
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("command.started", { itemId: "c1", command: "npm test" }));
    p = projectEvent(p, ev("command.completed", { itemId: "c1", exitCode: 1 }));
    expect((p.items[0] as { status: string }).status).toBe("failed");
  });

  it("upserts plan steps", () => {
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("plan.updated", {
      itemId: "p1",
      steps: [
        { text: "Inspect code", status: "completed" },
        { text: "Fix bug", status: "in_progress" },
      ],
    }));
    p = projectEvent(p, ev("plan.updated", {
      itemId: "p1",
      steps: [
        { text: "Inspect code", status: "completed" },
        { text: "Fix bug", status: "completed" },
        { text: "Run tests", status: "pending" },
      ],
    }));
    expect(p.items).toHaveLength(1);
    const item = p.items[0] as { steps: Array<{ status: string }> };
    expect(item.steps).toHaveLength(3);
    expect(item.steps[1].status).toBe("completed");
  });

  it("aggregates filechange patch stats", () => {
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("filechange.detected", { itemId: "f1", path: "src/a.ts", changeType: "modified" }));
    p = projectEvent(p, ev("filechange.patch", { itemId: "f1", additions: 32, deletions: 12, patch: "@@ -1,2 +1,3 @@" }));
    const item = p.items[0] as { additions: number; deletions: number; patch?: string };
    expect(item.additions).toBe(32);
    expect(item.deletions).toBe(12);
    expect(item.patch).toContain("@@");
  });

  it("adds and resolves pending approval", () => {
    const req: ApprovalRequest = {
      approvalId: "apr_1",
      threadId: "th_1",
      runId: "run_1",
      runtimeId: "test",
      backendId: "test-local",
      kind: "command",
      title: "Run command",
      detail: "rm -rf build",
      risk: "high",
      createdAt: new Date().toISOString(),
    };
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("approval.requested", req));
    expect(p.pendingApprovals).toHaveLength(1);
    expect(p.items).toHaveLength(1);

    p = projectEvent(p, ev("approval.resolved", { approvalId: "apr_1", decision: "rejected" }));
    expect(p.pendingApprovals).toHaveLength(0);
    expect((p.items[0] as { decision: string }).decision).toBe("rejected");
  });

  it("tracks run status transitions, ignores illegal ones", () => {
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("run.started", { runId: "run_1" }));
    expect(p.runs["run_1"].status).toBe("RUNNING");
    expect(p.activeRunId).toBe("run_1");

    p = projectEvent(p, ev("run.completed", { runId: "run_1" }));
    expect(p.runs["run_1"].status).toBe("COMPLETED");
    expect(p.activeRunId).toBeUndefined();

    // illegal: COMPLETED -> RUNNING must be ignored
    p = projectEvent(p, ev("run.started", { runId: "run_1" }));
    expect(p.runs["run_1"].status).toBe("COMPLETED");

    p = projectEvent(p, ev("run.failed", { runId: "run_2", message: "api down" }));
    expect(p.runs["run_2"].status).toBe("FAILED");
    expect(p.runs["run_2"].error).toBe("api down");
  });

  it("appends fatal error item and sets projection.error", () => {
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("error", { message: "runtime died", fatal: true }));
    expect((p.items[0] as { type: string }).type).toBe("error");
    expect(p.error).toBe("runtime died");
  });

  it("appends notice items", () => {
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("notice", { message: "model switched" }));
    expect((p.items[0] as { type: string }).type).toBe("notice");
    expect(p.error).toBeUndefined();
  });
});

describe("projectSnapshot", () => {
  it("overrides same-id items and appends new ones", () => {
    let p = emptyProjection("th_1");
    p = projectEvent(p, ev("message.delta", { itemId: "m1", delta: "partial" }));
    p = projectSnapshot(p, {
      items: [
        {
          id: "m1",
          threadId: "th_1",
          createdAt: new Date().toISOString(),
          type: "agent_message",
          text: "full server text",
          streaming: false,
        },
        {
          id: "m2",
          threadId: "th_1",
          createdAt: new Date().toISOString(),
          type: "user_message",
          text: "hi",
        },
      ],
      lastSequence: 99,
    });
    expect(p.items).toHaveLength(2);
    expect((p.items[0] as { text: string }).text).toBe("full server text");
    expect(p.lastSequence).toBe(99);
  });
});
