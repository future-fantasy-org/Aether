import { newId } from "@aether/agent-domain";
import type { Workspace } from "@aether/agent-domain";
import {
  HOST_METHODS,
  JsonRpcPeer,
  selfProcessStreams,
  socketStreams,
  type PeerStreams,
  type ApprovalRequest,
  type RuntimeEvent,
} from "@aether/agent-contracts";
import type { FileContent, FileEntry, FileStat, WorkspaceFileProvider } from "@aether/workspace-provider";
import { LocalFileProvider } from "@aether/workspace-provider";
import type { TerminalProvider, TerminalSession } from "@aether/terminal-provider";
import { LocalPtyProvider } from "@aether/terminal-provider";
import type { Artifact } from "@aether/agent-domain";
import { LocalArtifactProvider } from "@aether/artifact-provider";
import type { RegistryOptions } from "./registry.js";
import { defaultRegistry } from "./registry.js";
import { ConnectionManager } from "./connectionManager.js";
import { EventNormalizer } from "./eventNormalizer.js";
import { RunTracker } from "./runTracker.js";
import { HostLifecycle } from "./hostLifecycle.js";
import {
  SessionFile,
  defaultAetherHome,
  listenSocket,
  sessionFilePath,
  socketPathFor,
} from "./transports.js";
import type net from "node:net";
import fs from "node:fs";

export interface AetherHostOptions extends RegistryOptions {
  artifactsDir?: string;
  /** Root for the reconnect socket + session file (default ~/.aether). */
  aetherHome?: string;
  /** Orphan-mode approval timeout in ms (env AETHER_APPROVAL_TIMEOUT_MS, default 30min). */
  approvalTimeoutMs?: number;
}

export interface HostServeOptions {
  /** Primary stdio transport (defaults to this process's stdin/stdout). */
  stdio?: PeerStreams | null;
  /** Reconnect socket path; null disables Background Run support. */
  socketPath?: string | null;
  /** Session file path; null disables session discovery. */
  sessionFile?: string | null;
  /** Orphan-mode approval timeout (env AETHER_APPROVAL_TIMEOUT_MS, default 30min). */
  approvalTimeoutMs?: number;
}

/**
 * The Agent Execution Host (arch.md §7): the seam where runtime differences
 * stop. Speaks the Host RPC protocol over stdio *and* a reconnect socket, and
 * can outlive Electron while runs are in flight (Detached Run, arch.md §16).
 */
export class AetherHost {
  private opts: AetherHostOptions;
  private registry: ReturnType<typeof defaultRegistry>;
  private connections: ConnectionManager;
  private normalizer: EventNormalizer;
  private attached = new Set<string>();

  /** Connected RPC peers; `primary` receives notifications. */
  private peers = new Set<JsonRpcPeer>();
  private primary: JsonRpcPeer | undefined;

  private workspaces = new Map<string, Workspace>();
  private fileProviders = new Map<string, WorkspaceFileProvider>();
  private pendingApprovals = new Map<string, ApprovalRequest>();
  private terminals = new Map<string, TerminalSession>();
  private terminalProvider: TerminalProvider;
  private artifacts: LocalArtifactProvider;

  private runTracker = new RunTracker();
  private lifecycle: HostLifecycle;
  private server: net.Server | undefined;
  private session: SessionFile | undefined;
  private socketPath: string | null = null;
  private startedAt = new Date().toISOString();

  constructor(opts: AetherHostOptions = {}) {
    // AETHER_DEEPSEEK_BASE_URL lets smoke tests point the built-in harness at
    // a fake server and supports self-hosted DeepSeek-compatible endpoints.
    // AETHER_DEEPSEEK_SESSIONS_DIR keeps smoke session logs out of ~/.aether.
    const baseUrl = process.env.AETHER_DEEPSEEK_BASE_URL;
    const sessionsDir = process.env.AETHER_DEEPSEEK_SESSIONS_DIR;
    const envParams: Record<string, unknown> = {};
    if (baseUrl) envParams.baseUrl = baseUrl;
    if (sessionsDir) envParams.sessionsDir = sessionsDir;
    this.opts =
      Object.keys(envParams).length > 0
        ? {
            ...opts,
            deepSeekInitializeParams: {
              ...envParams,
              ...(opts.deepSeekInitializeParams ?? {}),
            },
          }
        : opts;
    this.registry = defaultRegistry(this.opts);
    this.connections = new ConnectionManager(this.registry);
    this.normalizer = new EventNormalizer((kind, payload) => {
      if (kind === "runtimeEvent") {
        this.runTracker.onEvent(payload as RuntimeEvent);
        this.lifecycle.onActiveRunsChanged();
      }
      if (kind === "approvalRequested") {
        const req = payload as ApprovalRequest;
        this.pendingApprovals.set(req.approvalId, req);
        this.lifecycle.onApprovalRequested(req.approvalId);
      }
      if (kind === "approvalResolved") {
        const p = payload as { approvalId: string };
        this.pendingApprovals.delete(p.approvalId);
        this.lifecycle.onApprovalResolved(p.approvalId);
      }
      this.primary?.notify(kind, payload);
    });
    this.terminalProvider = new LocalPtyProvider();
    this.artifacts = new LocalArtifactProvider(this.opts.artifactsDir);
    this.lifecycle = new HostLifecycle({
      hasActiveRuns: () => this.runTracker.hasActiveRuns(),
      rejectApproval: async (approvalId) => {
        await this.respondApprovalInternal(approvalId, "rejected");
      },
      exit: () => {
        void this.stop().finally(() => process.exit(0));
      },
      approvalTimeoutMs:
        opts.approvalTimeoutMs ??
        (process.env.AETHER_APPROVAL_TIMEOUT_MS
          ? Number(process.env.AETHER_APPROVAL_TIMEOUT_MS)
          : undefined),
    });
  }

  /**
   * Start serving. Default (bin) wiring: stdio + reconnect socket + session
   * file. Tests inject streams and disable the socket/session.
   */
  async start(serve: HostServeOptions = {}): Promise<void> {
    const home = this.opts.aetherHome ?? defaultAetherHome();

    if (serve.stdio !== null) {
      this.attachPeer(serve.stdio ?? selfProcessStreams(process));
    }

    if (serve.socketPath !== null) {
      this.socketPath = serve.socketPath ?? socketPathFor(home);
      this.server = await listenSocket(this.socketPath, (sock) => {
        this.attachPeer(socketStreams(sock));
      });
    }

    if (serve.sessionFile !== null) {
      this.session = new SessionFile(serve.sessionFile ?? sessionFilePath(home));
      this.session.write({
        protocol: 1,
        pid: process.pid,
        socketPath: this.socketPath ?? "",
        startedAt: this.startedAt,
      });
    }
  }

  private attachPeer(streams: PeerStreams): JsonRpcPeer {
    const peer = new JsonRpcPeer(streams);
    peer.onRequest((method, params) => this.handleRequest(method, params));
    peer.onClose(() => this.detachPeer(peer));
    this.peers.add(peer);
    // Newest peer wins primary (Electron reconnect takes over from a dead
    // stdio link).
    this.primary = peer;
    this.lifecycle.onClientAttached();
    return peer;
  }

  private detachPeer(peer: JsonRpcPeer): void {
    this.peers.delete(peer);
    if (this.primary === peer) {
      const next = [...this.peers].pop();
      if (next) {
        this.primary = next;
        this.lifecycle.onClientAttached();
      } else {
        this.primary = undefined;
        this.lifecycle.onClientDetached();
      }
    }
  }

  async stop(): Promise<void> {
    this.lifecycle.dispose();
    this.normalizer.dispose();
    await this.connections.disconnectAll();
    for (const [, t] of this.terminals) t.dispose();
    this.terminals.clear();
    this.session?.remove();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    // Unlink the socket so a stale path never blocks the next host.
    if (this.socketPath && process.platform !== "win32") {
      try {
        fs.rmSync(this.socketPath);
      } catch {
        /* already gone */
      }
    }
  }

  private async adapter(runtimeId: string, backendId: string) {
    const adapter = await this.connections.get(runtimeId, backendId);
    const key = `${runtimeId}:${backendId}`;
    if (!this.attached.has(key)) {
      this.attached.add(key);
      this.normalizer.attach(
        async () => adapter,
        runtimeId,
        backendId,
      );
    }
    return adapter;
  }

  private fileProvider(workspaceId: string): WorkspaceFileProvider {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) throw new Error(`unknown workspace: ${workspaceId}`);
    if (ws.binding.kind !== "local") throw new Error("non-local workspaces not supported in MVP");
    let provider = this.fileProviders.get(workspaceId);
    if (!provider) {
      provider = new LocalFileProvider(ws.binding.rootPath);
      this.fileProviders.set(workspaceId, provider);
    }
    return provider;
  }

  /** Shared by the RPC handler and orphan-mode approval timeouts. */
  private async respondApprovalInternal(
    approvalId: string,
    decision: "approved_once" | "approved_session" | "rejected" | "cancelled",
  ): Promise<void> {
    const req = this.pendingApprovals.get(approvalId);
    if (!req) throw new Error(`no pending approval: ${approvalId}`);
    const adapter = await this.adapter(req.runtimeId, req.backendId);
    await adapter.respondApproval({ approvalId, decision, raw: req });
    // Adapters also emit approval.resolved; clearing here is idempotent
    // and covers runtimes that do not emit the event.
    this.pendingApprovals.delete(approvalId);
    this.lifecycle.onApprovalResolved(approvalId);
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case HOST_METHODS.ping:
        return { ok: true, pid: process.pid, time: new Date().toISOString() };

      case HOST_METHODS.hostStatus:
        return {
          activeRuns: this.runTracker.activeCount(),
          orphan: this.lifecycle.isOrphan,
          socketPath: this.socketPath,
          startedAt: this.startedAt,
          pid: process.pid,
        };

      case HOST_METHODS.listRuntimes:
        return {
          runtimes: this.registry.list().map((d) => ({
            runtimeId: d.runtimeId,
            backendId: d.backendId,
            name: d.name,
            description: d.description,
            version: "0.1.0",
          })),
        };

      case HOST_METHODS.capabilities: {
        const d = this.registry.get(String(p.runtimeId), String(p.backendId));
        if (!d) throw new Error(`unknown runtime/backend: ${p.runtimeId}:${p.backendId}`);
        return {
          runtime: d.runtimeCapabilities,
          backend: d.backendCapabilities,
          effective: {
            plan: d.runtimeCapabilities.plan && d.backendCapabilities.fileSync,
            shell: d.runtimeCapabilities.shell,
            files: d.runtimeCapabilities.files && d.backendCapabilities.fileSync,
            mcp: d.runtimeCapabilities.mcp,
            subAgent: d.runtimeCapabilities.subAgent,
            approval: d.runtimeCapabilities.approval,
            steer: d.runtimeCapabilities.steer,
            fork: d.runtimeCapabilities.fork,
            interrupt: d.runtimeCapabilities.interrupt,
            reasoning: d.runtimeCapabilities.reasoning,
          },
        };
      }

      case HOST_METHODS.createWorkspace: {
        const now = new Date().toISOString();
        const workspace: Workspace = {
          id: newId("ws"),
          name: String(p.name ?? "Workspace"),
          binding: { kind: "local", rootPath: String(p.rootPath ?? process.cwd()) },
          settings: {},
          createdAt: now,
          updatedAt: now,
        };
        this.workspaces.set(workspace.id, workspace);
        return { workspace };
      }

      /** Main pushes persisted workspace metadata after host (re)start. */
      case "workspace/register": {
        const ws = p.workspace as Workspace;
        this.workspaces.set(ws.id, ws);
        return { ok: true };
      }

      case HOST_METHODS.createThread: {
        const adapter = await this.adapter(String(p.runtimeId), String(p.backendId));
        const threadId = String(p.threadId ?? newId("th"));
        const { externalThreadId } = await adapter.createThread({
          threadId,
          cwd: String(p.cwd ?? process.cwd()),
          model: p.model ? String(p.model) : undefined,
          approvalMode: (p.approvalMode as "askAlways" | "askDangerous" | "never") ?? "askDangerous",
        });
        return { thread: { id: threadId, externalThreadId } };
      }

      case HOST_METHODS.readThread: {
        const adapter = await this.adapter(String(p.runtimeId), String(p.backendId));
        const snap = await adapter.readThread(String(p.externalThreadId));
        return { items: snap.items, lastSequence: snap.lastSequence, title: snap.title };
      }

      case HOST_METHODS.startRun: {
        const adapter = await this.adapter(String(p.runtimeId), String(p.backendId));
        await adapter.startRun({
          threadId: String(p.threadId),
          externalThreadId: String(p.externalThreadId),
          runId: String(p.runId ?? newId("run")),
          text: String(p.text ?? ""),
        });
        return { ok: true };
      }

      case HOST_METHODS.interruptRun: {
        const adapter = await this.adapter(String(p.runtimeId), String(p.backendId));
        await adapter.interruptRun(String(p.externalThreadId));
        return { ok: true };
      }

      case HOST_METHODS.steerRun: {
        const adapter = await this.adapter(String(p.runtimeId), String(p.backendId));
        if (!adapter.steerRun) throw new Error("steer not supported by this runtime");
        await adapter.steerRun({
          threadId: String(p.threadId),
          externalThreadId: String(p.externalThreadId),
          text: String(p.text ?? ""),
        });
        return { ok: true };
      }

      case HOST_METHODS.respondApproval: {
        await this.respondApprovalInternal(
          String(p.approvalId),
          p.decision as "approved_once" | "approved_session" | "rejected" | "cancelled",
        );
        return { ok: true };
      }

      case HOST_METHODS.listPendingApprovals:
        return { approvals: [...this.pendingApprovals.values()] };

      case HOST_METHODS.fsList: {
        const entries: FileEntry[] = await this.fileProvider(String(p.workspaceId)).list(String(p.path ?? "."));
        return { entries };
      }
      case HOST_METHODS.fsRead: {
        const content: FileContent = await this.fileProvider(String(p.workspaceId)).read(
          String(p.path),
          p.maxBytes ? { maxBytes: Number(p.maxBytes) } : undefined,
        );
        return { content };
      }
      case HOST_METHODS.fsWrite:
        await this.fileProvider(String(p.workspaceId)).write(String(p.path), String(p.content ?? ""));
        return { ok: true };
      case HOST_METHODS.fsStat: {
        const stat: FileStat = await this.fileProvider(String(p.workspaceId)).stat(String(p.path));
        return { stat };
      }

      case HOST_METHODS.terminalCreate: {
        const ws = this.workspaces.get(String(p.workspaceId));
        const cwd = ws?.binding.kind === "local" ? ws.binding.rootPath : undefined;
        const session = await this.terminalProvider.create(cwd ?? p.cwd ? String(p.cwd ?? cwd) : undefined);
        this.terminals.set(session.id, session);
        session.onOutput((data) => {
          this.primary?.notify("terminalOutput", { terminalId: session.id, data });
        });
        session.onExit((exitCode) => {
          this.terminals.delete(session.id);
          this.primary?.notify("terminalExit", { terminalId: session.id, exitCode });
        });
        return { terminalId: session.id };
      }
      case HOST_METHODS.terminalWrite:
        this.terminals.get(String(p.terminalId))?.write(String(p.data ?? ""));
        return { ok: true };
      case HOST_METHODS.terminalResize:
        this.terminals.get(String(p.terminalId))?.resize(Number(p.cols), Number(p.rows));
        return { ok: true };
      case HOST_METHODS.terminalDispose:
        this.terminals.get(String(p.terminalId))?.dispose();
        return { ok: true };

      case HOST_METHODS.artifactList: {
        const list: Artifact[] = await this.artifacts.list(String(p.threadId));
        return { artifacts: list };
      }
      case HOST_METHODS.artifactSave: {
        const saved = await this.artifacts.save(String(p.threadId), {
          type: String(p.type ?? "text") as Artifact["type"],
          title: String(p.title ?? "Untitled"),
          metadata: {},
          content: String(p.content ?? ""),
        });
        return { artifact: saved };
      }
      case HOST_METHODS.artifactRead: {
        const read = await this.artifacts.read(String(p.artifactId));
        if (!read) throw new Error(`artifact not found: ${p.artifactId}`);
        return read;
      }
      case HOST_METHODS.artifactExport: {
        const exported = await this.artifacts.export(String(p.artifactId), String(p.destPath));
        return { artifact: exported };
      }

      case HOST_METHODS.setRuntimeSecret: {
        this.connections.setSecret(String(p.runtimeId), String(p.secret ?? ""));
        return { ok: true };
      }

      case HOST_METHODS.shutdown:
        // Respond first, then exit; the peer write is synchronous.
        setTimeout(() => {
          void this.stop().finally(() => process.exit(0));
        }, 50);
        return { ok: true };

      default:
        throw new Error(`unknown host method: ${method}`);
    }
  }
}

export type { RuntimeEvent };
