import { create } from "zustand";
import type { AgentItem } from "@aether/agent-domain";
import type { ApprovalRequest, RuntimeEvent } from "@aether/agent-contracts";
import {
  emptyProjection,
  projectEvent,
  projectSnapshot,
  type ThreadProjection,
} from "@aether/agent-projection";

interface TimelineStore {
  projections: Record<string, ThreadProjection>;
  approvals: ApprovalRequest[];
  hostStatus: string;
  eventCounts: Record<string, number>;
  applyEvent(ev: RuntimeEvent): void;
  loadSnapshot(threadId: string, items: AgentItem[], lastSequence: number): void;
  resetThread(threadId: string): void;
  addApproval(req: ApprovalRequest): void;
  removeApproval(approvalId: string): void;
  setHostStatus(status: string): void;
}

export const useTimelineStore = create<TimelineStore>((set) => ({
  projections: {},
  approvals: [],
  hostStatus: "starting",
  eventCounts: {},

  applyEvent: (ev) =>
    set((state) => {
      const current = state.projections[ev.threadId] ?? emptyProjection(ev.threadId);
      // Global (host-level) events don't belong to a thread timeline.
      if (ev.threadId === "*") {
        return {
          eventCounts: { ...state.eventCounts, [ev.type]: (state.eventCounts[ev.type] ?? 0) + 1 },
        };
      }
      const next = projectEvent(current, ev);
      return {
        projections: { ...state.projections, [ev.threadId]: next },
        eventCounts: { ...state.eventCounts, [ev.type]: (state.eventCounts[ev.type] ?? 0) + 1 },
      };
    }),

  loadSnapshot: (threadId, items, lastSequence) =>
    set((state) => {
      const current = state.projections[threadId] ?? emptyProjection(threadId);
      return {
        projections: { ...state.projections, [threadId]: projectSnapshot(current, { items, lastSequence }) },
      };
    }),

  resetThread: (threadId) =>
    set((state) => ({ projections: { ...state.projections, [threadId]: emptyProjection(threadId) } })),

  addApproval: (req) => set((s) => ({ approvals: [...s.approvals, req] })),
  removeApproval: (approvalId) =>
    set((s) => ({ approvals: s.approvals.filter((a) => a.approvalId !== approvalId) })),
  setHostStatus: (status) => set({ hostStatus: status }),
}));
