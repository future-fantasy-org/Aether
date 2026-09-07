import { promises as fs } from "node:fs";
import path from "node:path";
import type { Thread, Workspace } from "@aether/agent-domain";
import { DEFAULT_SETTINGS, type AppSettings } from "@aether/desktop-contracts";

/**
 * Platform metadata store (arch.md §36): workspaces, thread mappings,
 * settings, UI prefs. Aether owns presentation metadata only.
 * Prefers node:sqlite; falls back to an atomic JSON file.
 */
export interface PlatformStore {
  kind: "sqlite" | "json";
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  listWorkspaces(): Promise<Workspace[]>;
  upsertWorkspace(ws: Workspace): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  listThreads(workspaceId?: string): Promise<Thread[]>;
  upsertThread(t: Thread): Promise<void>;
  deleteThread(id: string): Promise<void>;
}

interface StoreData {
  settings: AppSettings;
  workspaces: Workspace[];
  threads: Thread[];
}

const emptyData = (): StoreData => ({
  settings: structuredClone(DEFAULT_SETTINGS),
  workspaces: [],
  threads: [],
});

class JsonStore implements PlatformStore {
  kind = "json" as const;
  private file: string;
  private data: StoreData = emptyData();

  constructor(userDataPath: string) {
    this.file = path.join(userDataPath, "store.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      this.data = {
        settings: { ...DEFAULT_SETTINGS, ...parsed.settings, ui: { ...DEFAULT_SETTINGS.ui, ...parsed.settings?.ui } },
        workspaces: parsed.workspaces ?? [],
        threads: parsed.threads ?? [],
      };
    } catch {
      this.data = emptyData();
    }
  }

  private async flush(): Promise<void> {
    const tmp = this.file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }

  async getSettings(): Promise<AppSettings> {
    return structuredClone(this.data.settings);
  }
  async setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.data.settings = {
      ...this.data.settings,
      ...patch,
      ui: { ...this.data.settings.ui, ...patch.ui },
    };
    await this.flush();
    return structuredClone(this.data.settings);
  }
  async listWorkspaces(): Promise<Workspace[]> {
    return structuredClone(this.data.workspaces);
  }
  async upsertWorkspace(ws: Workspace): Promise<void> {
    const i = this.data.workspaces.findIndex((w) => w.id === ws.id);
    if (i >= 0) this.data.workspaces[i] = ws;
    else this.data.workspaces.push(ws);
    await this.flush();
  }
  async deleteWorkspace(id: string): Promise<void> {
    this.data.workspaces = this.data.workspaces.filter((w) => w.id !== id);
    this.data.threads = this.data.threads.filter((t) => t.workspaceId !== id);
    await this.flush();
  }
  async listThreads(workspaceId?: string): Promise<Thread[]> {
    return structuredClone(
      workspaceId ? this.data.threads.filter((t) => t.workspaceId === workspaceId) : this.data.threads,
    );
  }
  async upsertThread(t: Thread): Promise<void> {
    const i = this.data.threads.findIndex((x) => x.id === t.id);
    if (i >= 0) this.data.threads[i] = t;
    else this.data.threads.push(t);
    await this.flush();
  }
  async deleteThread(id: string): Promise<void> {
    this.data.threads = this.data.threads.filter((t) => t.id !== id);
    await this.flush();
  }
}

export async function createPlatformStore(userDataPath: string): Promise<PlatformStore> {
  // node:sqlite in Electron main is version-dependent; an atomic JSON store
  // serves the same contract for MVP-sized platform metadata. Seam kept for a
  // future SQLite implementation behind PlatformStore.
  const store = new JsonStore(userDataPath);
  await store.load();
  return store;
}
