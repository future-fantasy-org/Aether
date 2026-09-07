import type { Thread } from "@aether/agent-domain";
import { runtimeClient } from "../../api/client.js";
import { useTimelineStore } from "../../stores/timeline.js";

/**
 * Selecting a thread restores its timeline: fetch the snapshot from the
 * runtime (adapter readThread) and fold it into the projection. Live events
 * keep flowing on top via the shared store.
 */
export async function selectThreadContext(thread: Thread): Promise<void> {
  if (!thread.runtimeBinding?.externalThreadId) return;
  const loadSnapshot = useTimelineStore.getState().loadSnapshot;
  try {
    const snap = await runtimeClient.readThread({
      threadId: thread.id,
      runtimeId: thread.runtimeBinding.runtimeId,
      backendId: thread.runtimeBinding.backendId,
      externalThreadId: thread.runtimeBinding.externalThreadId,
    });
    loadSnapshot(thread.id, snap.items, snap.lastSequence);
  } catch (err) {
    // Snapshot restore is best-effort (e.g. codex session rolled away).
    console.warn("[aether] thread snapshot failed", err);
  }
}
