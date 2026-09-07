import type { AgentItem, Run } from "@aether/agent-domain";
import type { ApprovalRequest } from "@aether/agent-contracts";

/** Immutable view model derived purely from RuntimeEvents. */
export interface ThreadProjection {
  threadId: string;
  items: AgentItem[];
  runs: Record<string, Run>;
  activeRunId: string | undefined;
  pendingApprovals: ApprovalRequest[];
  lastSequence: number;
  error: string | undefined;
}

export const emptyProjection = (threadId: string): ThreadProjection => ({
  threadId,
  items: [],
  runs: {},
  activeRunId: undefined,
  pendingApprovals: [],
  lastSequence: 0,
  error: undefined,
});
