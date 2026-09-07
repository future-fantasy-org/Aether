import { z } from "zod";

export const WorkspaceBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), rootPath: z.string() }),
  z.object({ kind: z.literal("remote"), backendId: z.string(), externalId: z.string() }),
  z.object({ kind: z.literal("repository"), url: z.string(), branch: z.string().optional() }),
  z.object({ kind: z.literal("managed"), providerId: z.string(), externalId: z.string() }),
]);
export type WorkspaceBinding = z.infer<typeof WorkspaceBindingSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  binding: WorkspaceBindingSchema,
  settings: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
