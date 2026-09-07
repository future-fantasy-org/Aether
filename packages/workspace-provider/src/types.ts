export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  modifiedAt?: string;
}

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
}

export interface FileStat {
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
}

/**
 * Location-agnostic file access (arch.md §28). The Files Surface never
 * knows whether files are local or remote.
 */
export interface WorkspaceFileProvider {
  list(path: string): Promise<FileEntry[]>;
  read(path: string, opts?: { maxBytes?: number }): Promise<FileContent>;
  write(path: string, content: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
}
