import { z } from "zod";

export const RuntimeEventTypeSchema = z.enum([
  "thread.started",
  "thread.titleUpdated",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  "message.delta",
  "message.completed",
  "reasoning.delta",
  "reasoning.completed",
  "plan.updated",
  "tool.started",
  "tool.completed",
  "command.started",
  "command.output",
  "command.completed",
  "filechange.detected",
  "filechange.patch",
  "approval.requested",
  "approval.resolved",
  "error",
  "notice",
]);
export type RuntimeEventType = z.infer<typeof RuntimeEventTypeSchema>;

export const RuntimeEventSchema = z.object({
  eventId: z.string(),
  /** Monotonic per thread; consumers drop stale sequences. */
  sequence: z.number().int(),
  timestamp: z.string(),
  runtimeId: z.string(),
  backendId: z.string(),
  /** Aether thread id (th_...), never the runtime's own thread id. */
  threadId: z.string(),
  runId: z.string().optional(),
  type: RuntimeEventTypeSchema,
  payload: z.unknown(),
  raw: z.unknown().optional(),
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

// ---- Payload shapes per event type (consumed by projection and adapters) ----

export interface ThreadStartedPayload {
  externalThreadId: string;
  title?: string;
}
export interface ThreadTitleUpdatedPayload {
  title: string;
}
export interface RunStartedPayload {
  runId: string;
}
export interface RunCompletedPayload {
  runId: string;
  reason?: string;
}
export interface RunFailedPayload {
  runId: string;
  message: string;
}
export interface MessageDeltaPayload {
  itemId: string;
  delta: string;
}
export interface MessageCompletedPayload {
  itemId: string;
  text: string;
}
export interface ReasoningDeltaPayload {
  itemId: string;
  delta: string;
}
export interface ReasoningCompletedPayload {
  itemId: string;
  text: string;
}
export interface PlanUpdatedPayload {
  itemId: string;
  steps: Array<{ text: string; status: "pending" | "in_progress" | "completed" }>;
}
export interface ToolStartedPayload {
  itemId: string;
  tool: string;
  input?: string;
}
export interface ToolCompletedPayload {
  itemId: string;
  tool: string;
  output?: string;
  ok: boolean;
}
export interface CommandStartedPayload {
  itemId: string;
  command: string;
}
export interface CommandOutputPayload {
  itemId: string;
  delta: string;
}
export interface CommandCompletedPayload {
  itemId: string;
  exitCode: number | null;
}
export interface FileChangeDetectedPayload {
  itemId: string;
  path: string;
  changeType: "added" | "modified" | "deleted";
}
export interface FileChangePatchPayload {
  itemId: string;
  additions: number;
  deletions: number;
  patch: string;
}
export interface ApprovalRequestedPayload {
  approvalId: string;
  kind: "command" | "fileChange" | "permission";
  title: string;
  detail?: string;
  risk: "low" | "medium" | "high";
}
export interface ApprovalResolvedPayload {
  approvalId: string;
  decision: "approved_once" | "approved_session" | "rejected" | "cancelled";
}
export interface ErrorPayload {
  message: string;
  fatal: boolean;
}
export interface NoticePayload {
  message: string;
}
