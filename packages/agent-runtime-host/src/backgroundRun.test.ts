import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunTracker } from "./runTracker.js";
import { HostLifecycle, type HostLifecycleDeps } from "./hostLifecycle.js";
import { SessionFile, sessionFilePath, socketPathFor } from "./transports.js";
import type { RuntimeEvent } from "@aether/agent-contracts";

function ev(type: string, runId?: string): RuntimeEvent {
  return {
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    sequence: 1,
    timestamp: new Date().toISOString(),
    runtimeId: "deepseek",
    backendId: "local",
    threadId: "th_1",
    runId,
    type: type as RuntimeEvent["type"],
    payload: runId ? { runId } : {},
  };
}

describe("RunTracker", () => {
  it("tracks a run as active between started and terminal events", () => {
    const t = new RunTracker();
    expect(t.hasActiveRuns()).toBe(false);
    t.onEvent(ev("run.started", "run_1"));
    expect(t.hasActiveRuns()).toBe(true);
    t.onEvent(ev("run.completed", "run_1"));
    expect(t.hasActiveRuns()).toBe(false);
  });

  it("terminal events for unknown ids do not clear other runs", () => {
    const t = new RunTracker();
    t.onEvent(ev("run.started", "run_1"));
    t.onEvent(ev("run.failed", "run_other"));
    expect(t.activeCount()).toBe(1);
  });

  it("falls back to payload.runId when the top-level id is missing", () => {
    const t = new RunTracker();
    const e = ev("run.started");
    e.runId = undefined;
    e.payload = { runId: "run_1" };
    t.onEvent(e);
    expect(t.hasActiveRuns()).toBe(true);
    t.onEvent(ev("run.interrupted", "run_1"));
    expect(t.hasActiveRuns()).toBe(false);
  });
});

/** Deterministic fake scheduler: collect timers, fire them explicitly. */
function fakeClock() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let now = 0;
  const deps = (extra: Partial<HostLifecycleDeps> = {}): HostLifecycleDeps => ({
    hasActiveRuns: () => false,
    rejectApproval: async () => {},
    exit: () => {},
    schedule: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return {
        clear: () => {
          t.cleared = true;
        },
      };
    },
    now: () => now,
    ...extra,
  });
  const fire = (predicate?: (ms: number) => boolean) => {
    for (const t of [...timers]) {
      if (t.cleared) continue;
      if (predicate && !predicate(t.ms)) continue;
      t.cleared = true;
      t.fn();
    }
  };
  return { deps, fire, timers };
}

describe("HostLifecycle", () => {
  it("detaching with active runs enters orphan mode and times out approvals", async () => {
    const rejected: string[] = [];
    const clock = fakeClock();
    const lc = new HostLifecycle(
      clock.deps({
        hasActiveRuns: () => true,
        rejectApproval: async (id) => {
          rejected.push(id);
        },
        approvalTimeoutMs: 1000,
      }),
    );

    lc.onApprovalRequested("ap_1"); // pending while client attached: no timer
    expect(clock.timers.length).toBe(0);

    lc.onClientDetached(); // orphaned
    expect(lc.isOrphan).toBe(true);
    lc.onApprovalRequested("ap_2"); // new approval while orphaned: armed
    expect(clock.timers.length).toBe(2);

    clock.fire();
    expect(rejected.sort()).toEqual(["ap_1", "ap_2"]);
  });

  it("reattaching clears pending approval timeouts", () => {
    const clock = fakeClock();
    const lc = new HostLifecycle(
      clock.deps({ hasActiveRuns: () => true, approvalTimeoutMs: 1000 }),
    );
    lc.onApprovalRequested("ap_1");
    lc.onClientDetached();
    expect(clock.timers.length).toBe(1);
    lc.onClientAttached();
    expect(clock.timers[0].cleared).toBe(true);
    clock.fire();
    // no rejection fired
  });

  it("detaching without active runs schedules the idle exit", () => {
    const exits: number[] = [];
    const clock = fakeClock();
    const lc = new HostLifecycle(
      clock.deps({
        hasActiveRuns: () => false,
        exit: () => exits.push(1),
        idleExitDelayMs: 500,
      }),
    );
    lc.onClientDetached();
    expect(clock.timers.length).toBe(1);
    clock.fire();
    expect(exits.length).toBe(1);
  });

  it("orphan exits once the last active run terminates", () => {
    let active = true;
    const clock = fakeClock();
    const lc = new HostLifecycle(
      clock.deps({ hasActiveRuns: () => active, exit: () => {}, idleExitDelayMs: 300 }),
    );
    lc.onClientDetached();
    expect(lc.isOrphan).toBe(true);
    active = false;
    lc.onActiveRunsChanged();
    expect(clock.timers.length).toBe(1); // exit scheduled
    active = true;
    lc.onActiveRunsChanged(); // a new run cancels the pending exit
    clock.fire();
    // exit not taken; reschedule happened instead
  });
});

describe("SessionFile", () => {
  it("round-trips session info and tolerates corruption", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-session-"));
    const file = new SessionFile(sessionFilePath(dir));
    expect(file.read()).toBeNull();
    file.write({
      protocol: 1,
      pid: process.pid,
      socketPath: socketPathFor(dir),
      startedAt: new Date().toISOString(),
    });
    expect(file.read()?.pid).toBe(process.pid);
    fs.writeFileSync(sessionFilePath(dir), "{not json");
    expect(file.read()).toBeNull();
    file.remove();
    expect(file.read()).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
