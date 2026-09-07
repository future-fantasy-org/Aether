import { newId } from "@aether/agent-domain";
import type { RuntimeCapabilities } from "@aether/agent-domain";
import type {
  AgentRuntimeAdapter,
  AgentThreadSummary,
  ApprovalRequest,
  ApprovalResponse,
  CreateThreadRequest,
  Disposable,
  RuntimeEvent,
  RuntimeInfo,
  StartRunRequest,
  SteerRequest,
  ThreadSnapshot,
} from "@aether/agent-contracts";
import { CodexAppServerTransport, defaultCodexCommand, type TransportOptions } from "./transport.js";
import {
  mapApprovalMode,
  mapApprovalRequest,
  mapDecision,
  mapNotification,
  mapThreadItem,
} from "./mapping.js";

/**
 * Adapter for the local Codex App Server (`codex app-server`, JSON-RPC over
 * stdio). Codex protocol changes are absorbed here — the UI never notices.
 */
export class CodexAdapter implements AgentRuntimeAdapter {
  readonly runtimeId = "codex";
  readonly backendId = "codex-local";

  private transport: CodexAppServerTransport;
  private listeners = new Set<(ev: RuntimeEvent) => void>();
  /** aether thread id -> external (codex) thread id and back. */
  private byAether = new Map<string, string>();
  private byExternal = new Map<string, string>();
  /** codex turnId -> aether runId. */
  private turnToRun = new Map<string, string>();
  /** approvalId -> deferred rpc response resolver. */
  private approvalResolvers = new Map<string, (decision: unknown) => void>();
  private sequence = 0;
  private connected = false;

  constructor(opts: TransportOptions = defaultCodexCommand()) {
    this.transport = new CodexAppServerTransport(opts);
  }

  async getInfo(): Promise<RuntimeInfo> {
    return {
      runtimeId: this.runtimeId,
      name: "Codex",
      version: "app-server (codex-cli)",
      description: "OpenAI Codex local agent runtime via `codex app-server`",
    };
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      plan: true,
      shell: true,
      files: true,
      mcp: true,
      subAgent: true,
      approval: true,
      steer: true,
      fork: true,
      interrupt: true,
      reasoning: true,
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.transport.connect();
    this.transport.onNotification((method, params) => this.handleNotification(method, params));
    this.transport.onRequest((method, params) => this.handleServerRequest(method, params));
    this.transport.onClose(() => {
      this.connected = false;
      this.emitToListeners({
        type: "error",
        threadId: "*",
        payload: { message: "codex app-server exited", fatal: true },
      });
    });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.transport.close();
  }

  async listThreads(): Promise<AgentThreadSummary[]> {
    await this.connect();
    const res = (await this.transport.request("thread/list", {})) as {
      data: Array<{ id: string; preview?: string; updatedAt?: string }>;
    };
    return res.data.map((t) => ({
      externalThreadId: t.id,
      title: t.preview ?? "Untitled",
      updatedAt: t.updatedAt ?? new Date().toISOString(),
      runtimeId: this.runtimeId,
    }));
  }

  async createThread(req: CreateThreadRequest): Promise<{ externalThreadId: string }> {
    await this.connect();
    const res = (await this.transport.request("thread/start", {
      cwd: req.cwd,
      ...(req.model ? { model: req.model } : {}),
      approvalPolicy: mapApprovalMode(req.approvalMode) ?? "on-request",
    })) as { thread: { id: string } };
    this.byAether.set(req.threadId, res.thread.id);
    this.byExternal.set(res.thread.id, req.threadId);
    this.emitToListeners({
      type: "thread.started",
      threadId: req.threadId,
      payload: { externalThreadId: res.thread.id },
    });
    return { externalThreadId: res.thread.id };
  }

  async readThread(externalThreadId: string): Promise<ThreadSnapshot> {
    await this.connect();
    const aetherId = this.byExternal.get(externalThreadId) ?? `replay_${externalThreadId}`;
    const res = (await this.transport.request("thread/read", {
      threadId: externalThreadId,
    })) as {
      thread: {
        preview?: string;
        turns?: Array<{ items?: unknown[] }>;
        items?: unknown[];
      };
    };
    const wireItems = (res.thread.turns ?? []).flatMap((t) => t.items ?? []) ?? res.thread.items ?? [];
    const timestamp = new Date().toISOString();
    const items = wireItems
      .map((it) => mapThreadItem(aetherId, it, timestamp))
      .filter((i): i is NonNullable<typeof i> => i !== undefined);
    return {
      externalThreadId,
      title: res.thread.preview ?? "",
      items,
      lastSequence: this.sequence,
    };
  }

  async startRun(req: StartRunRequest): Promise<void> {
    await this.connect();
    const res = (await this.transport.request("turn/start", {
      threadId: req.externalThreadId,
      input: [{ type: "text", text: req.text }],
    })) as { turn: { id: string } };
    this.turnToRun.set(res.turn.id, req.runId);
    this.byAether.set(req.threadId, req.externalThreadId);
    this.byExternal.set(req.externalThreadId, req.threadId);
  }

  async interruptRun(externalThreadId: string): Promise<void> {
    await this.connect();
    await this.transport.request("turn/interrupt", { threadId: externalThreadId });
  }

  async steerRun(req: SteerRequest): Promise<void> {
    await this.connect();
    await this.transport.request("turn/steer", {
      threadId: req.externalThreadId,
      input: [{ type: "text", text: req.text }],
    });
  }

  async respondApproval(res: ApprovalResponse & { raw: ApprovalRequest }): Promise<void> {
    const resolve = this.approvalResolvers.get(res.approvalId);
    if (resolve) {
      this.approvalResolvers.delete(res.approvalId);
      resolve(mapDecision(res.decision));
    }
  }

  subscribe(listener: (ev: RuntimeEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    void this.disconnect();
  }

  // ---- internals ----

  private handleNotification(method: string, params: unknown): void {
    const mapped = mapNotification(
      {
        threadIdFor: (wireThreadId) => this.byExternal.get(wireThreadId),
        runIdFor: (turnId) => this.turnToRun.get(turnId) ?? `run_${turnId}`,
      },
      method,
      params,
    );
    for (const m of mapped) {
      const p = (params ?? {}) as { threadId?: string };
      const threadId = this.byExternal.get(p.threadId ?? "") ?? (m.type === "error" ? "*" : undefined);
      if (!threadId) continue;
      this.emitToListeners({
        type: m.type,
        threadId,
        runId: m.turnId ? this.turnToRun.get(m.turnId) : undefined,
        payload: m.payload,
      });
    }
  }

  /** Codex asks for approval via server->client requests. */
  private handleServerRequest(method: string, params: unknown): Promise<unknown> {
    const mapped = mapApprovalRequest(method, params);
    if (!mapped) {
      return Promise.reject(new Error(`unhandled codex server request: ${method}`));
    }
    const p = (params ?? {}) as { threadId?: string; turnId?: string };
    const approvalId = newId("apr");
    const threadId = this.byExternal.get(p.threadId ?? "") ?? "";
    const request: ApprovalRequest = {
      approvalId,
      threadId,
      runId: p.turnId ? this.turnToRun.get(p.turnId) : undefined,
      runtimeId: this.runtimeId,
      backendId: this.backendId,
      kind: mapped.kind,
      title: mapped.title,
      detail: mapped.detail,
      risk: mapped.risk,
      createdAt: new Date().toISOString(),
    };
    this.emitToListeners({
      type: "approval.requested",
      threadId,
      runId: request.runId,
      payload: request,
    });
    return new Promise<unknown>((resolve) => {
      this.approvalResolvers.set(approvalId, (decision) => {
        this.emitToListeners({
          type: "approval.resolved",
          threadId,
          runId: request.runId,
          payload: { approvalId, decision },
        });
        resolve(decision);
      });
    });
  }

  private emitToListeners(e: {
    type: RuntimeEvent["type"];
    threadId: string;
    runId?: string;
    payload: unknown;
  }): void {
    const event: RuntimeEvent = {
      eventId: newId("evt"),
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      runtimeId: this.runtimeId,
      backendId: this.backendId,
      threadId: e.threadId,
      runId: e.runId,
      type: e.type,
      payload: e.payload,
    };
    for (const l of this.listeners) l(event);
  }
}
