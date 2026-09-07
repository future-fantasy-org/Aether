import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  FileContent,
  FileEntry,
  FileStat,
  WorkspaceFileProvider,
} from "./types.js";

const DEFAULT_MAX_BYTES = 512 * 1024;

export class PathOutsideWorkspaceError extends Error {
  constructor(readonly resolved: string) {
    super(`path escapes workspace root: ${resolved}`);
    this.name = "PathOutsideWorkspaceError";
  }
}

/** Sandbox-resolved path: throws if relative path escapes root. */
export function resolveInside(root: string, rel: string): string {
  const abs = rel.startsWith("/") ? rel : path.join(root, rel);
  const resolved = path.resolve(abs);
  const relToRoot = path.relative(path.resolve(root), resolved);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    throw new PathOutsideWorkspaceError(resolved);
  }
  return resolved;
}

export class LocalFileProvider implements WorkspaceFileProvider {
  constructor(private root: string) {}

  private toRelative(resolved: string): string {
    return path.relative(path.resolve(this.root), resolved) || ".";
  }

  async list(rel: string): Promise<FileEntry[]> {
    const dir = resolveInside(this.root, rel);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: FileEntry[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      let size: number | undefined;
      let modifiedAt: string | undefined;
      try {
        const s = await fs.stat(full);
        size = s.size;
        modifiedAt = s.mtime.toISOString();
      } catch {
        /* dangling symlink etc. */
      }
      out.push({
        name: e.name,
        path: this.toRelative(full),
        kind: e.isDirectory() ? "directory" : "file",
        size,
        modifiedAt,
      });
    }
    out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  async read(rel: string, opts?: { maxBytes?: number }): Promise<FileContent> {
    const max = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
    const file = resolveInside(this.root, rel);
    const buf = await fs.readFile(file);
    const truncated = buf.byteLength > max;
    return {
      path: this.toRelative(file),
      content: buf.subarray(0, max).toString("utf8"),
      truncated,
    };
  }

  async write(rel: string, content: string): Promise<void> {
    const file = resolveInside(this.root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }

  async stat(rel: string): Promise<FileStat> {
    const file = resolveInside(this.root, rel);
    const s = await fs.stat(file);
    return {
      path: this.toRelative(file),
      kind: s.isDirectory() ? "directory" : "file",
      size: s.size,
      modifiedAt: s.mtime.toISOString(),
    };
  }
}
