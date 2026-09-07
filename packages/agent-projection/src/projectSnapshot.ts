import type { AgentItem } from "@aether/agent-domain";
import type { ThreadProjection } from "./state.js";

/**
 * Fold a thread snapshot (from adapter.readThread, e.g. after reconnect or app
 * restart) into an existing projection. Snapshot items override same-id local
 * items (finalized versions of streaming content); unknown snapshot items are
 * appended in order.
 */
export function projectSnapshot(
  prev: ThreadProjection,
  snapshot: { items: AgentItem[]; lastSequence: number },
): ThreadProjection {
  const byId = new Map<string, AgentItem>();
  const ordered: AgentItem[] = [];

  for (const item of prev.items) {
    byId.set(item.id, item);
    ordered.push(item);
  }
  for (const item of snapshot.items) {
    const existing = byId.get(item.id);
    if (existing) {
      const idx = ordered.indexOf(existing);
      ordered[idx] = item; // snapshot version wins (server truth)
    } else {
      ordered.push(item);
      byId.set(item.id, item);
    }
  }

  return {
    ...prev,
    items: ordered,
    lastSequence: Math.max(prev.lastSequence, snapshot.lastSequence),
  };
}
