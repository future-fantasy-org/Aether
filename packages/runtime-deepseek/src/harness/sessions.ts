import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ChatMessage } from "./deepseekClient.js";

export const defaultSessionsDir = (): string =>
  path.join(os.homedir(), ".aether", "runtimes", "deepseek", "sessions");

export interface EventRecord {
  seq: number;
  ts: string;
  kind: "event";
  type: string;
  payload: unknown;
}

export interface MessageRecord {
  seq: number;
  ts: string;
  kind: "message";
  message: ChatMessage;
}

export type HarnessRecord = EventRecord | MessageRecord;

export interface SessionMeta {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Append-only JSONL session log. The harness runtime owns execution truth
 * (arch.md §36); Aether only replays it.
 */
export class SessionStore {
  private seq = 0;
  private readonly file: string;
  private readonly metaFile: string;
  private records: HarnessRecord[] = [];
  meta: SessionMeta;

  constructor(
    readonly sessionId: string,
    private readonly dir: string,
    meta?: Partial<SessionMeta>,
  ) {
    this.file = path.join(dir, `${sessionId}.jsonl`);
    this.metaFile = path.join(dir, `${sessionId}.meta.json`);
    this.meta = {
      sessionId,
      title: meta?.title ?? "New chat",
      createdAt: meta?.createdAt ?? new Date().toISOString(),
      updatedAt: meta?.updatedAt ?? new Date().toISOString(),
    };
  }

  static async load(sessionId: string, dir: string): Promise<SessionStore> {
    const store = new SessionStore(sessionId, dir);
    await store.hydrate();
    return store;
  }

  /** Load existing records (if any) and restore the sequence counter. */
  async hydrate(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fs.readFile(this.metaFile, "utf8");
      this.meta = { ...this.meta, ...(JSON.parse(raw) as SessionMeta) };
    } catch {
      /* first time */
    }
    try {
      const raw = await fs.readFile(this.file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as HarnessRecord;
          this.records.push(rec);
          if (rec.seq > this.seq) this.seq = rec.seq;
        } catch {
          /* tolerate torn tail line */
        }
      }
    } catch {
      /* first time */
    }
    await this.persistMeta();
  }

  nextSeq(): number {
    return ++this.seq;
  }

  appendEvent(type: string, payload: unknown): EventRecord {
    const rec: EventRecord = { seq: this.nextSeq(), ts: new Date().toISOString(), kind: "event", type, payload };
    this.records.push(rec);
    void fs.appendFile(this.file, JSON.stringify(rec) + "\n", "utf8");
    void this.touch();
    return rec;
  }

  appendMessage(message: ChatMessage): MessageRecord {
    const rec: MessageRecord = { seq: this.nextSeq(), ts: new Date().toISOString(), kind: "message", message };
    this.records.push(rec);
    void fs.appendFile(this.file, JSON.stringify(rec) + "\n", "utf8");
    void this.touch();
    return rec;
  }

  /** Chat history for the model (messages only, in order). */
  chatMessages(): ChatMessage[] {
    return this.records.filter((r): r is MessageRecord => r.kind === "message").map((r) => r.message);
  }

  eventRecords(): EventRecord[] {
    return this.records.filter((r): r is EventRecord => r.kind === "event");
  }

  lastSequence(): number {
    return this.seq;
  }

  async setTitle(title: string): Promise<void> {
    this.meta.title = title;
    await this.persistMeta();
  }

  private async touch(): Promise<void> {
    this.meta.updatedAt = new Date().toISOString();
    await this.persistMeta();
  }

  private async persistMeta(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.metaFile, JSON.stringify(this.meta), "utf8");
  }
}

/** Scan a sessions dir for persisted sessions. */
export async function listSessions(dir: string): Promise<SessionMeta[]> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const f of files) {
    if (!f.endsWith(".meta.json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      out.push(JSON.parse(raw) as SessionMeta);
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}
