import { newId } from "@aether/agent-domain";
import type {
  ApprovalRequest,
  RuntimeEvent,
} from "@aether/agent-contracts";

export type HostEventSink = (kind: string, payload: unknown) => void;

/**
 * Subscribes to adapter event streams, enforces per-thread monotonic
 * sequences and forwards normalized events (plus approval side-channels)
 * to the host sink (arch.md §7 Event Normalizer).
 */
export class EventNormalizer {
  private lastSequence = new Map<string, number>();
  private disposers: Array<{ dispose(): void }> = [];

  constructor(private sink: HostEventSink) {}

  attach(
    getAdapter: () => Promise<import("@aether/agent-contracts").AgentRuntimeAdapter>,
    runtimeId: string,
    backendId: string,
  ): void {
    void getAdapter().then((adapter) => {
      const disposer = adapter.subscribe((ev) => this.onAdapterEvent(ev, runtimeId, backendId));
      this.disposers.push(disposer);
    });
  }

  private onAdapterEvent(ev: RuntimeEvent, runtimeId: string, backendId: string): void {
    const key = `${ev.threadId}`;
    const last = this.lastSequence.get(key) ?? 0;
    // Adapters number events from 1 per process; keep monotonic per thread.
    const sequence = ev.sequence > last ? ev.sequence : last + 1;
    this.lastSequence.set(key, sequence);

    const normalized: RuntimeEvent = {
      ...ev,
      eventId: ev.eventId || newId("evt"),
      sequence,
      timestamp: ev.timestamp || new Date().toISOString(),
      runtimeId: ev.runtimeId || runtimeId,
      backendId: ev.backendId || backendId,
    };
    this.sink("runtimeEvent", normalized);

    if (normalized.type === "approval.requested") {
      this.sink("approvalRequested", normalized.payload as ApprovalRequest);
    }
    if (normalized.type === "approval.resolved") {
      this.sink("approvalResolved", normalized.payload);
    }
    if (normalized.type.startsWith("run.")) {
      this.sink("runStateUpdated", {
        threadId: normalized.threadId,
        runId: normalized.runId,
        type: normalized.type,
        payload: normalized.payload,
      });
    }
  }

  dispose(): void {
    for (const d of this.disposers) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposers = [];
  }
}
