import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  JsonRpcPeer,
  RuntimeEventSchema,
  childProcessStreams,
  type AgentRuntimeAdapter,
  type AgentThreadSummary,
  type CreateThreadRequest,
  type RuntimeEvent,
  type RuntimeInfo,
  type StartRunRequest,
  type SteerRequest,
  type ThreadSnapshot,
  type ApprovalResponse,
  type ApprovalRequest,
  type Disposable,
} from "@aether/agent-contracts";
import type { RuntimeCapabilities } from "@aether/agent-domain";
import { emptyProjection, projectEvent } from "@aether/agent-projection";
import { BACKEND_ID, HARNESS_VERSION, RUNTIME_ID } from "./harness/server.js";

export interface DeepSeekAdapterOptions {
  /** Executable to run the harness (default: current node). */
  command?: string;
  /** Args to reach the harness bin (default: resolved dist path). */
  args?: string[];
  /** Extra initialize params (baseUrl, model override, tests inject sessionsDir). */
  initializeParams?: Record<string, unknown>;
}

/** Resolve the harness bin shipped in this package (dist first, src fallback). */
export function defaultHarnessArgs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.resolve(here, "harness/bin/deepseek-harness.js");
  if (existsSync(dist)) return [dist];
  return [path.resolve(here, "harness/bin/deepseek-harness.ts")];
}

/**
 * Adapter for the built-in DeepSeek Harness reference runtime. Harness events
 * are already RuntimeEvent-shaped, so this adapter mainly manages process
 * lifecycle, thread mapping and approval routing.
 */
export class DeepSeekAdapter implements AgentRuntimeAdapter {
  readonly runtimeId = RUNTIME_ID;
  readonly backendId = BACKEND_ID;

  private cp: ChildProcess | undefined;
  private peer: JsonRpcPeer | undefined;
  private listeners = new Set<(ev: RuntimeEvent) => void>();
  /** approvalId -> resolver for the pending harness approval request. */
  private approvalResolvers = new Map<string, (decision: unknown) => void>();

  constructor(private opts: DeepSeekAdapterOptions = {}) {}

  async getInfo(): Promise<RuntimeInfo> {
    return {
      runtimeId: RUNTIME_ID,
      name: "DeepSeek Harness",
      version: HARNESS_VERSION,
      description: "Built-in reference agent runtime powered by the DeepSeek API",
    };
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      plan: false,
      shell: true,
      files: true,
      mcp: false,
      subAgent: false,
      approval: true,
      steer: false,
      fork: false,
      interrupt: true,
      reasoning: true,
    };
  }

  async connect(secret?: string): Promise<void> {
    if (this.cp && !this.cp.killed) return;
    const command = this.opts.command ?? process.execPath;
    const args = this.opts.args ?? defaultHarnessArgs();
    this.cp = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    this.peer = new JsonRpcPeer(childProcessStreams(this.cp));

    this.peer.onNotification((method, params) => {
      if (method !== "runtimeEvent") return;
      const parsed = RuntimeEventSchema.safeParse(params);
      if (parsed.success) for (const l of this.listeners) l(parsed.data);
    });

    // The harness asks for approval via a server->client request. We keep the
    // response pending until the user decides (respondApproval resolves it).
    // The matching approval.requested RuntimeEvent already flows via notify.
    this.peer.onRequest((method, params) => {
      if (method !== "approval/request") {
        return Promise.reject(new Error(`unexpected harness request: ${method}`));
      }
      const p = params as { approvalId: string };
      return new Promise<unknown>((resolve) => {
        this.approvalResolvers.set(p.approvalId, resolve);
      });
    });

    await this.peer.request("initialize", {
      clientInfo: { name: "aether", title: "Aether", version: "0.1.0" },
      ...(secret ? { apiKey: secret } : {}),
      ...(this.opts.initializeParams ?? {}),
    });
  }

  async disconnect(): Promise<void> {
    this.cp?.kill();
    this.cp = undefined;
    this.peer = undefined;
  }

  async listThreads(): Promise<AgentThreadSummary[]> {
    this.assertConnected();
    const res = (await this.peer!.request("thread/list", {})) as {
      threads: Array<{ externalThreadId: string; title: string; updatedAt: string }>;
    };
    return res.threads.map((t) => ({ ...t, runtimeId: RUNTIME_ID }));
  }

  async createThread(req: CreateThreadRequest): Promise<{ externalThreadId: string }> {
    this.assertConnected();
    return (await this.peer!.request("thread/start", {
      threadId: req.threadId,
      cwd: req.cwd,
      model: req.model,
      approvalMode: req.approvalMode ?? "askDangerous",
      title: "New chat",
    })) as { externalThreadId: string };
  }

  async readThread(externalThreadId: string): Promise<ThreadSnapshot> {
    this.assertConnected();
    const res = (await this.peer!.request("thread/read", {
      externalThreadId,
    })) as {
      events: Array<{ seq: number; ts: string; type: string; payload: unknown }>;
      lastSequence: number;
      title?: string;
    };
    // Replay raw harness events through the projection to rebuild AgentItems.
    const threadId = `replay_${externalThreadId}`;
    let projection = emptyProjection(threadId);
    for (const rec of res.events) {
      projection = projectEvent(projection, {
        eventId: `evt_replay_${rec.seq}`,
        sequence: rec.seq,
        timestamp: rec.ts,
        runtimeId: RUNTIME_ID,
        backendId: BACKEND_ID,
        threadId,
        type: rec.type as RuntimeEvent["type"],
        payload: rec.payload,
      });
    }
    return {
      externalThreadId,
      title: res.title ?? "",
      items: projection.items,
      lastSequence: res.lastSequence,
    };
  }

  async startRun(req: StartRunRequest): Promise<void> {
    this.assertConnected();
    await this.peer!.request("turn/start", {
      threadId: req.threadId,
      externalThreadId: req.externalThreadId,
      runId: req.runId,
      text: req.text,
    });
  }

  async interruptRun(externalThreadId: string): Promise<void> {
    this.assertConnected();
    await this.peer!.request("turn/interrupt", { externalThreadId });
  }

  async steerRun(_req: SteerRequest): Promise<void> {
    throw new Error("steer not supported by deepseek runtime");
  }

  async respondApproval(res: ApprovalResponse & { raw: ApprovalRequest }): Promise<void> {
    const resolve = this.approvalResolvers.get(res.approvalId);
    if (resolve) {
      this.approvalResolvers.delete(res.approvalId);
      resolve({ decision: res.decision });
    }
  }

  subscribe(listener: (ev: RuntimeEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    void this.disconnect();
  }

  private assertConnected(): void {
    if (!this.peer || !this.cp || this.cp.killed) {
      throw new Error("DeepSeek harness not connected (call connect() first)");
    }
  }
}
