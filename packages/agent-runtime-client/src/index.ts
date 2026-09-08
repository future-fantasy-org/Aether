import { HOST_METHODS } from "@aether/agent-contracts";
import type {
  ApprovalDecisionValue,
  ApprovalRequest,
  RuntimeEvent,
} from "@aether/agent-contracts";
import type { AgentItem } from "@aether/agent-domain";

/** Transport seam implemented by the preload bridge (or tests). */
export interface ClientBridge {
  hostRequest(op: string, payload?: unknown): Promise<unknown>;
  onHostEvent(cb: (envelope: { kind: string; payload: unknown }) => void): () => void;
}

export interface RuntimeListResult {
  runtimes: Array<{
    runtimeId: string;
    backendId: string;
    name: string;
    description: string;
    version: string;
  }>;
}

export interface EffectiveCapabilities {
  plan: boolean;
  shell: boolean;
  files: boolean;
  mcp: boolean;
  subAgent: boolean;
  approval: boolean;
  steer: boolean;
  fork: boolean;
  interrupt: boolean;
  reasoning: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  modifiedAt?: string;
}

export interface ArtifactMeta {
  id: string;
  type: string;
  title: string;
  location: { kind: "local"; path: string } | { kind: "remote"; url: string };
  createdAt: string;
}

type RuntimeEventListener = (ev: RuntimeEvent) => void;
type TerminalListener = (payload: { terminalId: string; data?: string; exitCode?: number }) => void;

/**
 * Renderer-side typed client for the Agent Execution Host. Events fan out to
 * per-kind listeners; all state derivation stays in the projection layer.
 */
export class AetherRuntimeClient {
  private runtimeListeners = new Set<RuntimeEventListener>();
  private approvalListeners = new Set<(req: ApprovalRequest) => void>();
  private approvalResolvedListeners = new Set<(p: { approvalId: string; decision: string }) => void>();
  private statusListeners = new Set<(status: { status: string; error?: string }) => void>();
  private terminalListeners = new Map<string, Set<TerminalListener>>();
  private unsubscribe: (() => void) | undefined;

  constructor(private bridge: ClientBridge) {}

  connect(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.bridge.onHostEvent((envelope) => {
      switch (envelope.kind) {
        case "runtimeEvent":
          this.runtimeListeners.forEach((l) => l(envelope.payload as RuntimeEvent));
          if ((envelope.payload as RuntimeEvent).type === "approval.requested") {
            this.approvalListeners.forEach((l) => l(envelope.payload as unknown as ApprovalRequest));
          }
          break;
        case "approvalRequested":
          this.approvalListeners.forEach((l) => l(envelope.payload as ApprovalRequest));
          break;
        case "approvalResolved":
          this.approvalResolvedListeners.forEach((l) =>
            l(envelope.payload as { approvalId: string; decision: string }),
          );
          break;
        case "hostStatus":
          this.statusListeners.forEach((l) => l(envelope.payload as { status: string; error?: string }));
          break;
        case "terminalOutput":
        case "terminalExit": {
          const p = envelope.payload as { terminalId: string };
          const set = this.terminalListeners.get(p.terminalId);
          if (set) set.forEach((l) => l(envelope.payload as never));
          break;
        }
        default:
          break;
      }
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.runtimeListeners.clear();
  }

  onRuntimeEvent(l: RuntimeEventListener): () => void {
    this.runtimeListeners.add(l);
    return () => this.runtimeListeners.delete(l);
  }
  onApproval(l: (req: ApprovalRequest) => void): () => void {
    this.approvalListeners.add(l);
    return () => this.approvalListeners.delete(l);
  }
  onApprovalResolved(l: (p: { approvalId: string; decision: string }) => void): () => void {
    this.approvalResolvedListeners.add(l);
    return () => this.approvalResolvedListeners.delete(l);
  }
  onHostStatus(l: (status: { status: string; error?: string }) => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }
  onTerminal(terminalId: string, l: TerminalListener): () => void {
    let set = this.terminalListeners.get(terminalId);
    if (!set) {
      set = new Set();
      this.terminalListeners.set(terminalId, set);
    }
    set.add(l);
    return () => {
      set!.delete(l);
      if (set!.size === 0) this.terminalListeners.delete(terminalId);
    };
  }

  // ---- Host RPC wrappers ----

  listRuntimes(): Promise<RuntimeListResult> {
    return this.bridge.hostRequest(HOST_METHODS.listRuntimes) as Promise<RuntimeListResult>;
  }

  capabilities(runtimeId: string, backendId: string): Promise<{ effective: EffectiveCapabilities }> {
    return this.bridge.hostRequest(HOST_METHODS.capabilities, { runtimeId, backendId }) as Promise<{
      effective: EffectiveCapabilities;
    }>;
  }

  createThread(params: {
    threadId: string;
    runtimeId: string;
    backendId: string;
    cwd: string;
    title?: string;
    model?: string;
    approvalMode?: "askAlways" | "askDangerous" | "never";
  }): Promise<{ thread: { id: string; externalThreadId: string } }> {
    return this.bridge.hostRequest(HOST_METHODS.createThread, params) as Promise<{
      thread: { id: string; externalThreadId: string };
    }>;
  }

  readThread(params: {
    threadId: string;
    runtimeId: string;
    backendId: string;
    externalThreadId: string;
  }): Promise<{ items: AgentItem[]; lastSequence: number; title: string }> {
    return this.bridge.hostRequest(HOST_METHODS.readThread, params) as Promise<{
      items: AgentItem[];
      lastSequence: number;
      title: string;
    }>;
  }

  startRun(params: {
    threadId: string;
    runtimeId: string;
    backendId: string;
    externalThreadId: string;
    runId: string;
    text: string;
  }): Promise<{ ok: boolean }> {
    return this.bridge.hostRequest(HOST_METHODS.startRun, params) as Promise<{ ok: boolean }>;
  }

  interruptRun(params: {
    threadId: string;
    runtimeId: string;
    backendId: string;
    externalThreadId: string;
  }): Promise<{ ok: boolean }> {
    return this.bridge.hostRequest(HOST_METHODS.interruptRun, params) as Promise<{ ok: boolean }>;
  }

  steerRun(params: {
    threadId: string;
    runtimeId: string;
    backendId: string;
    externalThreadId: string;
    text: string;
  }): Promise<{ ok: boolean }> {
    return this.bridge.hostRequest(HOST_METHODS.steerRun, params) as Promise<{ ok: boolean }>;
  }

  respondApproval(approvalId: string, decision: ApprovalDecisionValue): Promise<{ ok: boolean }> {
    return this.bridge.hostRequest(HOST_METHODS.respondApproval, {
      approvalId,
      decision,
    }) as Promise<{ ok: boolean }>;
  }

  /** Pending approvals on the host — restores cards after reconnecting to a detached host. */
  listPendingApprovals(): Promise<{ approvals: ApprovalRequest[] }> {
    return this.bridge.hostRequest(HOST_METHODS.listPendingApprovals) as Promise<{
      approvals: ApprovalRequest[];
    }>;
  }

  fsList(workspaceId: string, dirPath: string): Promise<{ entries: FileEntry[] }> {
    return this.bridge.hostRequest(HOST_METHODS.fsList, {
      workspaceId,
      path: dirPath,
    }) as Promise<{ entries: FileEntry[] }>;
  }

  fsRead(workspaceId: string, filePath: string): Promise<{ content: { path: string; content: string; truncated: boolean } }> {
    return this.bridge.hostRequest(HOST_METHODS.fsRead, {
      workspaceId,
      path: filePath,
    }) as Promise<{ content: { path: string; content: string; truncated: boolean } }>;
  }

  fsWrite(workspaceId: string, filePath: string, content: string): Promise<{ ok: boolean }> {
    return this.bridge.hostRequest(HOST_METHODS.fsWrite, {
      workspaceId,
      path: filePath,
      content,
    }) as Promise<{ ok: boolean }>;
  }

  terminalCreate(workspaceId: string): Promise<{ terminalId: string }> {
    return this.bridge.hostRequest(HOST_METHODS.terminalCreate, {
      workspaceId,
    }) as Promise<{ terminalId: string }>;
  }

  terminalWrite(terminalId: string, data: string): Promise<{ ok: boolean }> {
    return this.bridge.hostRequest(HOST_METHODS.terminalWrite, { terminalId, data }) as Promise<{
      ok: boolean;
    }>;
  }

  terminalResize(terminalId: string, cols: number, rows: number): Promise<{ ok: boolean }> {
    return this.bridge.hostRequest(HOST_METHODS.terminalResize, { terminalId, cols, rows }) as Promise<{
      ok: boolean;
    }>;
  }

  terminalDispose(terminalId: string): Promise<{ ok: boolean }> {
    return this.bridge.hostRequest(HOST_METHODS.terminalDispose, { terminalId }) as Promise<{
      ok: boolean;
    }>;
  }

  artifactList(threadId: string): Promise<{ artifacts: ArtifactMeta[] }> {
    return this.bridge.hostRequest(HOST_METHODS.artifactList, { threadId }) as Promise<{
      artifacts: ArtifactMeta[];
    }>;
  }

  artifactRead(artifactId: string): Promise<{ artifact: ArtifactMeta; content: string }> {
    return this.bridge.hostRequest(HOST_METHODS.artifactRead, { artifactId }) as Promise<{
      artifact: ArtifactMeta;
      content: string;
    }>;
  }

  artifactExport(artifactId: string, destPath: string): Promise<{ artifact: ArtifactMeta }> {
    return this.bridge.hostRequest(HOST_METHODS.artifactExport, {
      artifactId,
      destPath,
    }) as Promise<{ artifact: ArtifactMeta }>;
  }
}
