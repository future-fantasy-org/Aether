import { z } from "zod";

export const RuntimeBindingSchema = z.object({
  runtimeId: z.string(), // "codex" | "deepseek" | future
  backendId: z.string(), // "codex-local" | "deepseek-local" | future
  externalThreadId: z.string().optional(),
  runtimeVersion: z.string().optional(),
  protocolVersion: z.string().optional(),
});
export type RuntimeBinding = z.infer<typeof RuntimeBindingSchema>;

export const ThreadSchema = z.object({
  /** Aether Thread ID (th_ prefix) — never the runtime's own id. */
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  runtimeBinding: RuntimeBindingSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean().default(false),
});
export type Thread = z.infer<typeof ThreadSchema>;
