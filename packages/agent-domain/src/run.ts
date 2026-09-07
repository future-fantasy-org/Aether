import { z } from "zod";

export const RunStatusSchema = z.enum([
  "QUEUED",
  "STARTING",
  "RUNNING",
  "WAITING_TOOL",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
  "DISCONNECTED",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  status: RunStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  error: z.string().optional(),
});
export type Run = z.infer<typeof RunSchema>;

/** Legal run state transitions, shared by host and projection. */
export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  QUEUED: ["STARTING", "CANCELLED", "FAILED"],
  STARTING: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: [
    "WAITING_TOOL",
    "WAITING_APPROVAL",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "INTERRUPTED",
    "DISCONNECTED",
  ],
  WAITING_TOOL: ["RUNNING", "FAILED", "CANCELLED", "INTERRUPTED", "DISCONNECTED"],
  WAITING_APPROVAL: ["RUNNING", "FAILED", "CANCELLED", "INTERRUPTED", "DISCONNECTED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: [],
  DISCONNECTED: [],
};

export const canTransition = (from: RunStatus, to: RunStatus): boolean =>
  from === to || RUN_TRANSITIONS[from].includes(to);

export const isTerminalRunStatus = (status: RunStatus): boolean =>
  RUN_TRANSITIONS[status].length === 0;
