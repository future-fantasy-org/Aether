import { z } from "zod";

const base = z.object({
  id: z.string(),
  threadId: z.string(),
  runId: z.string().optional(),
  createdAt: z.string(),
});

export const PlanStepSchema = z.object({
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const ApprovalDecisionSchema = z.enum([
  "pending",
  "approved_once",
  "approved_session",
  "rejected",
  "cancelled",
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const AgentItemSchema = z.discriminatedUnion("type", [
  base.extend({ type: z.literal("user_message"), text: z.string() }),
  base.extend({
    type: z.literal("agent_message"),
    text: z.string(),
    streaming: z.boolean().default(false),
  }),
  base.extend({
    type: z.literal("reasoning_summary"),
    text: z.string(),
    streaming: z.boolean().default(false),
  }),
  base.extend({ type: z.literal("plan"), steps: z.array(PlanStepSchema) }),
  base.extend({
    type: z.literal("tool_call"),
    tool: z.string(),
    input: z.string().optional(),
    output: z.string().optional(),
    status: z.enum(["running", "completed", "failed"]),
  }),
  base.extend({
    type: z.literal("command"),
    command: z.string(),
    output: z.string().default(""),
    exitCode: z.number().optional(),
    status: z.enum(["running", "completed", "failed"]),
  }),
  base.extend({
    type: z.literal("file_change"),
    path: z.string(),
    changeType: z.enum(["added", "modified", "deleted"]),
    additions: z.number().default(0),
    deletions: z.number().default(0),
    patch: z.string().optional(),
  }),
  base.extend({ type: z.literal("browser"), action: z.string(), detail: z.string().optional() }),
  base.extend({ type: z.literal("search"), query: z.string(), results: z.number().optional() }),
  base.extend({
    type: z.literal("approval"),
    approvalId: z.string(),
    title: z.string(),
    detail: z.string().optional(),
    risk: z.enum(["low", "medium", "high"]),
    decision: ApprovalDecisionSchema.default("pending"),
  }),
  base.extend({
    type: z.literal("artifact"),
    artifactId: z.string(),
    title: z.string(),
    artifactType: z.string(),
  }),
  base.extend({ type: z.literal("sub_agent"), agent: z.string(), status: z.string() }),
  base.extend({ type: z.literal("error"), message: z.string(), fatal: z.boolean().default(false) }),
  base.extend({ type: z.literal("notice"), message: z.string() }),
]);

export type AgentItem = z.infer<typeof AgentItemSchema>;
export type AgentItemType = AgentItem["type"];
