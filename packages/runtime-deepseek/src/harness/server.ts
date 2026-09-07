import { newId } from "@aether/agent-domain";
import {
  JsonRpcPeer,
  selfProcessStreams,
  type PeerStreams,
  type RuntimeEvent,
  type RuntimeEventType,
} from "@aether/agent-contracts";
import { runTurn, type ApprovalAsk, type ApprovalDecision, type LoopContext } from "./agentLoop.js";
import { SessionStore, defaultSessionsDir, listSessions } from "./sessions.js";
import type { ApprovalMode } from "./approvals.js";

export const HARNESS_VERSION = "0.1.0";
export const RUNTIME_ID = "deepseek";
export const BACKEND_ID = "deepseek-local";

interface HarnessConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  sessionsDir: string;
}

interface LiveSession {
  store: SessionStore;
  aetherThreadId: string;
  cwd: string;
  model: string;
  approvalMode: ApprovalMode;
  interrupt: boolean;
  running: boolean;
}

/**
 * The DeepSeek Harness reference runtime: a standalone Node process speaking
 * JSON-RPC 2.0 over stdio. Spawned by the Aether DeepSeekAdapter.
 */
export class HarnessServer {
  private peer: JsonRpcPeer | undefined;
  private config: HarnessConfig = {
    apiKey: "",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    sessionsDir: defaultSessionsDir(),
  };
  private sessions = new Map<string, LiveSession>(); // externalThreadId -> session

  /** Start serving on stdio (or injected PeerStreams for tests). */
  async start(streams?: PeerStreams): Promise<void> {
    this.peer = new JsonRpcPeer(streams ?? selfProcessStreams(process));
    this.peer.onRequest((method, params) => this.handleRequest(method, params));
  }

  private sessionByExternal(externalThreadId: string): LiveSession | undefined {
    return this.sessions.get(externalThreadId);
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "initialize":
        this.config = {
          apiKey: typeof p.apiKey === "string" ? p.apiKey : this.config.apiKey,
          baseUrl: typeof p.baseUrl === "string" && p.baseUrl ? p.baseUrl : this.config.baseUrl,
          model: typeof p.model === "string" && p.model ? p.model : this.config.model,
          sessionsDir:
            typeof p.sessionsDir === "string" && p.sessionsDir ? p.sessionsDir : this.config.sessionsDir,
        };
        return { harnessVersion: HARNESS_VERSION };

      case "thread/start": {
        const sessionId = `ds_${newId("s")}`;
        const store = new SessionStore(sessionId, this.config.sessionsDir, {
          title: typeof p.title === "string" && p.title ? p.title : "New chat",
        });
        await store.hydrate();
        this.sessions.set(sessionId, {
          store,
          aetherThreadId: String(p.threadId ?? ""),
          cwd: String(p.cwd ?? process.cwd()),
          model: typeof p.model === "string" && p.model ? p.model : this.config.model,
          approvalMode: (p.approvalMode as ApprovalMode) ?? "askDangerous",
          interrupt: false,
          running: false,
        });
        return { externalThreadId: sessionId };
      }

      case "thread/list": {
        const metas = await listSessions(this.config.sessionsDir);
        return {
          threads: metas.map((m) => ({
            externalThreadId: m.sessionId,
            title: m.title,
            updatedAt: m.updatedAt,
            runtimeId: RUNTIME_ID,
          })),
        };
      }

      case "thread/read": {
        const ext = String(p.externalThreadId ?? p.threadId ?? "");
        const live = this.sessionByExternal(ext);
        if (live) {
          return { events: live.store.eventRecords(), lastSequence: live.store.lastSequence() };
        }
        const store = await SessionStore.load(ext, this.config.sessionsDir);
        return { events: store.eventRecords(), lastSequence: store.lastSequence(), title: store.meta.title };
      }

      case "turn/start": {
        const ext = String(p.externalThreadId ?? p.threadId ?? "");
        const session = this.sessionByExternal(ext);
        if (!session) throw new Error(`unknown thread: ${ext}`);
        if (session.running) throw new Error("a turn is already running on this thread");
        if (!this.config.apiKey) throw new Error("no API key configured (initialize first)");
        const text = String(p.text ?? "");
        const runId = String(p.runId ?? newId("run"));

        session.running = true;
        session.interrupt = false;
        // Async fire-and-forget; events stream via notifications.
        void this.executeTurn(session, runId, text);
        return { ok: true, runId };
      }

      case "turn/interrupt": {
        const ext = String(p.externalThreadId ?? p.threadId ?? "");
        const session = this.sessionByExternal(ext);
        if (!session) throw new Error(`unknown thread: ${ext}`);
        session.interrupt = true;
        return { ok: true };
      }

      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private emit(session: LiveSession, runId: string, type: RuntimeEventType, payload: unknown): void {
    const rec = session.store.appendEvent(type, payload);
    const event: RuntimeEvent = {
      eventId: `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      sequence: rec.seq,
      timestamp: rec.ts,
      runtimeId: RUNTIME_ID,
      backendId: BACKEND_ID,
      threadId: session.aetherThreadId,
      runId,
      type,
      payload,
    };
    this.peer?.notify("runtimeEvent", event);
  }

  private async executeTurn(session: LiveSession, runId: string, text: string): Promise<void> {
    const ctx: LoopContext = {
      runId,
      cwd: session.cwd,
      model: session.model,
      approvalMode: session.approvalMode,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      emit: (type, payload) => this.emit(session, runId, type as RuntimeEventType, payload),
      requestApproval: (ask: ApprovalAsk) => this.requestApproval(session, runId, ask),
      interrupted: () => session.interrupt,
    };
    try {
      await runTurn(ctx, session.store, text);
    } finally {
      session.running = false;
    }
  }

  private async requestApproval(
    session: LiveSession,
    runId: string,
    ask: ApprovalAsk,
  ): Promise<ApprovalDecision> {
    const approvalId = `apr_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    this.emit(session, runId, "approval.requested", {
      approvalId,
      threadId: session.aetherThreadId,
      runId,
      runtimeId: RUNTIME_ID,
      backendId: BACKEND_ID,
      kind: ask.kind,
      title: ask.title,
      detail: ask.detail,
      risk: ask.risk,
      createdAt: new Date().toISOString(),
    });
    let decision: ApprovalDecision;
    try {
      const res = (await this.peer?.request("approval/request", {
        approvalId,
        kind: ask.kind,
        title: ask.title,
        detail: ask.detail,
        risk: ask.risk,
      })) as { decision?: ApprovalDecision } | undefined;
      decision = res?.decision ?? "cancelled";
    } catch {
      decision = "cancelled";
    }
    this.emit(session, runId, "approval.resolved", { approvalId, decision });
    return decision;
  }
}
