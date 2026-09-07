import { z } from "zod";

export const ArtifactTypeSchema = z.enum([
  "markdown",
  "code",
  "pdf",
  "excel",
  "image",
  "report",
  "text",
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  type: ArtifactTypeSchema,
  title: z.string(),
  location: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local"), path: z.string() }),
    z.object({ kind: z.literal("remote"), backendId: z.string(), url: z.string() }),
  ]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
