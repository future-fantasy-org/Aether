import type { Artifact, ArtifactType } from "@aether/agent-domain";

export type ArtifactDraft = Omit<Artifact, "id" | "createdAt" | "location"> & {
  content: string;
};

/** Location-agnostic artifact access (arch.md §30). */
export interface ArtifactProvider {
  save(threadId: string, artifact: ArtifactDraft): Promise<Artifact>;
  list(threadId: string): Promise<Artifact[]>;
  read(artifactId: string): Promise<{ artifact: Artifact; content: string } | undefined>;
  export(artifactId: string, destPath: string): Promise<Artifact>;
}

export const EXT_BY_TYPE: Record<ArtifactType, string> = {
  markdown: "md",
  code: "txt",
  pdf: "pdf",
  excel: "xlsx",
  image: "png",
  report: "md",
  text: "txt",
};

export const inferType = (title: string, declared?: string): ArtifactType => {
  if (declared) {
    const t = declared as ArtifactType;
    if (["markdown", "code", "pdf", "excel", "image", "report", "text"].includes(t)) return t;
  }
  const ext = title.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md") return "markdown";
  if (["ts", "tsx", "js", "py", "rs", "go", "java"].includes(ext)) return "code";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  return "text";
};
