import { describe, expect, it } from "vitest";
import {
  mapApprovalMode,
  mapApprovalRequest,
  mapDecision,
  mapNotification,
  mapThreadItem,
} from "./mapping.js";

const ctx = {
  threadIdFor: (id: string) => (id === "wire_th" ? "th_1" : undefined),
  runIdFor: (turnId: string) => `run_for_${turnId}`,
};

describe("mapThreadItem", () => {
  const ts = "2026-09-08T00:00:00Z";

  it("maps userMessage", () => {
    const item = mapThreadItem("th_1", {
      type: "userMessage",
      id: "i1",
      content: [{ type: "text", text: "fix the bug" }],
    }, ts);
    expect(item).toMatchObject({ type: "user_message", text: "fix the bug" });
  });

  it("maps agentMessage", () => {
    const item = mapThreadItem("th_1", { type: "agentMessage", id: "i2", text: "done" }, ts);
    expect(item).toMatchObject({ type: "agent_message", text: "done", streaming: false });
  });

  it("maps reasoning with summary", () => {
    const item = mapThreadItem(
      "th_1",
      { type: "reasoning", id: "i3", summary: ["a", "b"], content: [] },
      ts,
    );
    expect(item).toMatchObject({ type: "reasoning_summary", text: "a\nb" });
  });

  it("maps commandExecution lifecycle states", () => {
    const running = mapThreadItem(
      "th_1",
      { type: "commandExecution", id: "i4", command: "npm test", status: "inProgress" },
      ts,
    );
    expect(running).toMatchObject({ type: "command", status: "running" });
    const done = mapThreadItem(
      "th_1",
      { type: "commandExecution", id: "i4", command: "npm test", status: "completed" },
      ts,
    );
    expect(done).toMatchObject({ type: "command", status: "completed", exitCode: 0 });
  });

  it("maps fileChange with diff stats", () => {
    const item = mapThreadItem(
      "th_1",
      {
        type: "fileChange",
        id: "i5",
        status: "completed",
        changes: [{ path: "src/a.ts", kind: "modified", diff: "@@\n+line1\n+line2\n-old" }],
      },
      ts,
    );
    expect(item).toMatchObject({
      type: "file_change",
      path: "src/a.ts",
      changeType: "modified",
      additions: 2,
      deletions: 1,
    });
  });

  it("ignores unknown item types", () => {
    expect(mapThreadItem("th_1", { type: "contextCompaction", id: "i6" }, ts)).toBeUndefined();
  });
});

describe("mapNotification", () => {
  it("maps message and reasoning deltas", () => {
    expect(
      mapNotification(ctx, "item/agentMessage/delta", {
        threadId: "wire_th",
        turnId: "t1",
        itemId: "m1",
        delta: "Hi",
      }),
    ).toEqual([{ type: "message.delta", payload: { itemId: "m1", delta: "Hi" }, turnId: "t1" }]);

    expect(
      mapNotification(ctx, "item/reasoning/summaryTextDelta", {
        threadId: "wire_th",
        turnId: "t1",
        itemId: "r1",
        delta: "hmm",
      }),
    ).toEqual([{ type: "reasoning.delta", payload: { itemId: "r1", delta: "hmm" }, turnId: "t1" }]);
  });

  it("maps turn lifecycle", () => {
    expect(
      mapNotification(ctx, "turn/started", { threadId: "wire_th", turn: { id: "t1" } }),
    ).toEqual([{ type: "run.started", payload: { runId: "run_for_t1" }, turnId: "t1" }]);

    expect(
      mapNotification(ctx, "turn/completed", { threadId: "wire_th", turn: { id: "t1", status: "completed" } }),
    ).toEqual([{ type: "run.completed", payload: { runId: "run_for_t1" }, turnId: "t1" }]);

    expect(
      mapNotification(ctx, "turn/completed", { threadId: "wire_th", turn: { id: "t1", status: "interrupted" } }),
    ).toEqual([{ type: "run.cancelled", payload: { runId: "run_for_t1" }, turnId: "t1" }]);
  });

  it("maps item started/completed for commands and files", () => {
    expect(
      mapNotification(ctx, "item/started", {
        threadId: "wire_th",
        turnId: "t1",
        item: { type: "commandExecution", id: "c1", command: "ls", status: "inProgress" },
      }),
    ).toEqual([{ type: "command.started", payload: { itemId: "c1", command: "ls" }, turnId: "t1" }]);

    const fileCompleted = mapNotification(ctx, "item/completed", {
      threadId: "wire_th",
      turnId: "t1",
      item: {
        type: "fileChange",
        id: "f1",
        status: "completed",
        changes: [{ path: "a.ts", kind: "added", diff: "+x" }],
      },
    });
    expect(fileCompleted.map((e) => e.type)).toEqual(["filechange.detected", "filechange.patch"]);
  });

  it("maps command output deltas", () => {
    expect(
      mapNotification(ctx, "item/commandExecution/outputDelta", {
        threadId: "wire_th",
        turnId: "t1",
        itemId: "c1",
        delta: "out",
      }),
    ).toEqual([{ type: "command.output", payload: { itemId: "c1", delta: "out" }, turnId: "t1" }]);
  });

  it("maps plan updates", () => {
    expect(
      mapNotification(ctx, "turn/plan/updated", {
        threadId: "wire_th",
        turnId: "t1",
        plan: [{ text: "step", status: "completed" }],
      }),
    ).toEqual([
      {
        type: "plan.updated",
        payload: { itemId: "plan_t1", steps: [{ text: "step", status: "completed" }] },
        turnId: "t1",
      },
    ]);
  });

  it("drops notifications for untracked threads", () => {
    expect(mapNotification(ctx, "item/agentMessage/delta", { threadId: "other" })).toEqual([]);
  });
});

describe("approvals", () => {
  it("classifies dangerous commands as high risk", () => {
    const mapped = mapApprovalRequest("item/commandExecution/requestApproval", {
      threadId: "wire_th",
      command: { command: "rm -rf build" },
    });
    expect(mapped).toMatchObject({ kind: "command", risk: "high", detail: "rm -rf build" });
  });

  it("maps file change approvals", () => {
    const mapped = mapApprovalRequest("item/fileChange/requestApproval", {
      threadId: "wire_th",
      changes: [{ path: "src/a.ts" }],
    });
    expect(mapped).toMatchObject({ kind: "fileChange", detail: "src/a.ts" });
  });

  it("maps decisions both ways", () => {
    expect(mapDecision("approved_once")).toBe("accept");
    expect(mapDecision("approved_session")).toBe("acceptForSession");
    expect(mapDecision("rejected")).toBe("decline");
    expect(mapDecision("cancelled")).toBe("cancel");
    expect(mapApprovalMode("askAlways")).toBe("untrusted");
    expect(mapApprovalMode("askDangerous")).toBe("on-request");
    expect(mapApprovalMode("never")).toBe("never");
  });
});
