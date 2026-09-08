import type { RuntimeEvent } from "@aether/agent-contracts";

/**
 * Projects run liveness from the normalized event stream (Background Run).
 *
 * A run is *active* from its `run.started` event until a terminal run event
 * arrives. WAITING_TOOL / WAITING_APPROVAL stay active by design — an agent
 * blocked on an approval must keep the host alive when Electron quits
 * (arch.md §16: the UI is not the owner of the run lifecycle).
 *
 * Conservative by design: unknown payloads or missing runId fall back to
 * counting thread-level events as "unknown run" so a lost id can never make
 * an in-flight run invisible to the liveness check.
 */
export class RunTracker {
  private active = new Map<string, number>();

  /** Fold one normalized runtime event into the tracker. */
  onEvent(event: RuntimeEvent): void {
    const payload = event.payload as { runId?: unknown } | undefined;
    const runId = event.runId ?? payload?.runId;
    switch (event.type) {
      case "run.started": {
        const id = String(runId ?? event.threadId);
        this.active.set(id, Date.now());
        return;
      }
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
      case "run.interrupted": {
        if (runId != null) this.active.delete(String(runId));
        return;
      }
      default:
        return;
    }
  }

  hasActiveRuns(): boolean {
    return this.active.size > 0;
  }

  activeCount(): number {
    return this.active.size;
  }
}
