import { newId } from "@aether/agent-domain";
import type { Workspace } from "@aether/agent-domain";
import {
  HOST_METHODS,
  JsonRpcPeer,
  selfProcessStreams,
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

export interface AetherHostOptions extends RegistryOptions {
  artifactsDir?: string;
}

/**
 * The Agent Execution Host (arch.md §7): the seam where runtime differences
 * stop. Runs as a sidecar process spawned by Electron Main and speaks the
 * Host RPC protocol (JSON-RPC 2.0 over stdio).
 */
export class AetherHost {
  private opts: AetherHostOptions;
  private registry: ReturnType<typeof defaultRegistry>;
  private connections: ConnectionManager;
  private normalizer: EventNormalizer;
  private attached = new Set<string>();
  private peer: JsonRpcPeer | undefined;

  private workspaces = new Map<string, Workspace>();
  private fileProviders = new Map<string, WorkspaceFileProvider>();
  private pendingApprovals = new Map<string, ApprovalRequest>();
  private terminals = new Map<string, TerminalSession>();
  private terminalProvider: TerminalProvider;
  private artifacts: LocalArtifactProvider;

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
      if (kind === "approvalRequested") {
        const req = payload as ApprovalRequest;
        this.pendingApprovals.set(req.approvalId, req);
      }
      if (kind === "approvalResolved") {
        const p = payload as { approvalId: string };
        this.pendingApprovals.delete(p.approvalId);
      }
      this.peer?.notify(kind, payload);
    });
    this.terminalProvider = new LocalPtyProvider();
    this.artifacts = new LocalArtifactProvider(this.opts.artifactsDir);
  }

  /** Start serving on stdio (or injected streams for tests). */
  start(streams?: PeerStreams): void {
    this.peer = new JsonRpcPeer(streams ?? selfProcessStreams(process));
    this.peer.onRequest((method, params) => this.handleRequest(method, params));
  }

  async stop(): Promise<void> {
    this.normalizer.dispose();
    await this.connections.disconnectAll();
    for (const [, t] of this.terminals) t.dispose();
    this.terminals.clear();
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

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case HOST_METHODS.ping:
        return { ok: true, pid: process.pid, time: new Date().toISOString() };

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
        const req = this.pendingApprovals.get(String(p.approvalId));
        if (!req) throw new Error(`no pending approval: ${p.approvalId}`);
        const adapter = await this.adapter(req.runtimeId, req.backendId);
        await adapter.respondApproval({
          approvalId: req.approvalId,
          decision: p.decision as "approved_once" | "approved_session" | "rejected" | "cancelled",
          raw: req,
        });
        // Adapters also emit approval.resolved; clearing here is idempotent
        // and covers runtimes that do not emit the event.
        this.pendingApprovals.delete(req.approvalId);
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
          this.peer?.notify("terminalOutput", { terminalId: session.id, data });
        });
        session.onExit((exitCode) => {
          this.terminals.delete(session.id);
          this.peer?.notify("terminalExit", { terminalId: session.id, exitCode });
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
