import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { newId } from "@aether/agent-domain";
import type { Artifact } from "@aether/agent-domain";
import { EXT_BY_TYPE, inferType, type ArtifactDraft, type ArtifactProvider } from "./types.js";

/**
 * Artifact store under ~/.aether/artifacts/<threadId>/<artifactId>(.ext)
 * plus a <artifactId>.json metadata sidecar.
 */
export class LocalArtifactProvider implements ArtifactProvider {
  private readonly root: string;
  private readonly index = new Map<string, Artifact>(); // artifactId -> meta (lazy loaded)

  constructor(root?: string) {
    this.root = root ?? path.join(os.homedir(), ".aether", "artifacts");
  }

  private threadDir(threadId: string): string {
    // sanitize to avoid path traversal from thread ids
    const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.root, safe);
  }

  private metaPath(artifactId: string, threadId: string): string {
    return path.join(this.threadDir(threadId), `${artifactId}.json`);
  }

  async save(threadId: string, draft: ArtifactDraft): Promise<Artifact> {
    const artifact: Artifact = {
      id: newId("art"),
      type: inferType(draft.title, draft.type),
      title: draft.title,
      location: { kind: "local", path: "" }, // filled below
      metadata: draft.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    const dir = this.threadDir(threadId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${artifact.id}.${EXT_BY_TYPE[artifact.type]}`);
    const buf = draft.type === "image" && draft.content.length % 4 === 0 && draft.content.startsWith("/") ? Buffer.from(draft.content, "base64") : Buffer.from(draft.content, "utf8");
    await fs.writeFile(file, buf);
    artifact.location = { kind: "local", path: file };
    await fs.writeFile(this.metaPath(artifact.id, threadId), JSON.stringify({ ...artifact, threadId }), "utf8");
    this.index.set(artifact.id, artifact);
    return artifact;
  }

  async list(threadId: string): Promise<Artifact[]> {
    const dir = this.threadDir(threadId);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: Artifact[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const meta = JSON.parse(raw) as Artifact;
        this.index.set(meta.id, meta);
        out.push(meta);
      } catch {
        /* skip corrupt sidecars */
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  async read(artifactId: string): Promise<{ artifact: Artifact; content: string } | undefined> {
    const artifact = this.index.get(artifactId);
    if (!artifact || artifact.location.kind !== "local") return undefined;
    try {
      const content = await fs.readFile(artifact.location.path, "utf8");
      return { artifact, content };
    } catch {
      return undefined;
    }
  }

  async export(artifactId: string, destPath: string): Promise<Artifact> {
    const found = await this.read(artifactId);
    if (!found) throw new Error(`artifact not found: ${artifactId}`);
    if (found.artifact.location.kind !== "local") throw new Error("remote export not supported in MVP");
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(found.artifact.location.path, destPath);
    return { ...found.artifact, location: { kind: "local", path: destPath } };
  }
}
