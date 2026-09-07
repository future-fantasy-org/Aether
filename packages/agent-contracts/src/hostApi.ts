/**
 * Host RPC protocol — single source of truth for method names and payloads.
 * Wire format: JSON-RPC 2.0 over stdio (JSONL) between Electron Main and the
 * Agent Execution Host sidecar.
 */
import type {
  AgentItem,
  BackendCapabilities,
  RuntimeCapabilities,
  Thread,
  Workspace,
} from "@aether/agent-domain";
import type { ApprovalDecisionValue, ApprovalRequest } from "./approval.js";
import type { RuntimeEvent } from "./events.js";

export const HOST_METHODS = {
  ping: "host/ping",
  shutdown: "host/shutdown",
  listRuntimes: "host/listRuntimes",
  listBackends: "host/listBackends",
  capabilities: "host/capabilities",

  listWorkspaces: "workspace/list",
  createWorkspace: "workspace/create",

  listThreads: "thread/list",
  createThread: "thread/create",
  renameThread: "thread/rename",
  archiveThread: "thread/archive",
  readThread: "thread/read",
  selectRuntime: "thread/select",

  startRun: "run/start",
  interruptRun: "run/interrupt",
  steerRun: "run/steer",

  respondApproval: "approval/respond",
  listPendingApprovals: "approval/listPending",

  fsList: "fs/list",
  fsRead: "fs/read",
  fsWrite: "fs/write",
  fsStat: "fs/stat",

  terminalCreate: "terminal/create",
  terminalWrite: "terminal/write",
  terminalResize: "terminal/resize",
  terminalDispose: "terminal/dispose",

  artifactList: "artifact/list",
  artifactRead: "artifact/read",
  artifactSave: "artifact/save",
  artifactExport: "artifact/export",

  setRuntimeSecret: "settings/setRuntimeSecret",
} as const;

export const HOST_NOTIFICATIONS = {
  runtimeEvent: "runtimeEvent",
  approvalRequested: "approvalRequested",
  approvalResolved: "approvalResolved",
  runStateUpdated: "runStateUpdated",
  hostStatus: "hostStatus",
  terminalOutput: "terminalOutput",
  terminalExit: "terminalExit",
} as const;

// ---- Request payloads / results ----

export interface ListRuntimesResult {
  runtimes: Array<{
    runtimeId: string;
    backendId: string;
    name: string;
    description: string;
    version: string;
  }>;
}

export interface CapabilitiesParams {
  runtimeId: string;
  backendId: string;
}
export interface CapabilitiesResult {
  runtime: RuntimeCapabilities;
  backend: BackendCapabilities;
  effective: RuntimeCapabilities;
}

export interface CreateWorkspaceParams {
  name: string;
  rootPath: string;
}
export interface CreateThreadParams {
  workspaceId: string;
  runtimeId: string;
  backendId: string;
  title?: string;
  model?: string;
  approvalMode?: "askAlways" | "askDangerous" | "never";
}
export interface ReadThreadParams {
  threadId: string;
  runtimeId: string;
  backendId: string;
  externalThreadId: string;
}
export interface ReadThreadResult {
  items: AgentItem[];
  lastSequence: number;
  title: string;
}

export interface StartRunParams {
  threadId: string;
  runtimeId: string;
  backendId: string;
  externalThreadId: string;
  text: string;
}
export interface InterruptRunParams {
  threadId: string;
  runtimeId: string;
  backendId: string;
  externalThreadId: string;
}
export interface SteerRunParams extends StartRunParams {}

export interface RespondApprovalParams {
  approvalId: string;
  decision: ApprovalDecisionValue;
}
export interface PendingApprovalsResult {
  approvals: ApprovalRequest[];
}

export interface FsListParams {
  workspaceId: string;
  path: string;
}
export interface FsReadParams {
  workspaceId: string;
  path: string;
  maxBytes?: number;
}
export interface FsWriteParams {
  workspaceId: string;
  path: string;
  content: string;
}
export interface FsStatParams {
  workspaceId: string;
  path: string;
}

export interface TerminalCreateParams {
  workspaceId: string;
  cwd?: string;
}
export interface TerminalWriteParams {
  terminalId: string;
  data: string;
}
export interface TerminalResizeParams {
  terminalId: string;
  cols: number;
  rows: number;
}
export interface TerminalDisposeParams {
  terminalId: string;
}
export interface TerminalOutputNotification {
  terminalId: string;
  data: string;
}
export interface TerminalExitNotification {
  terminalId: string;
  exitCode: number;
}

export interface ArtifactListParams {
  threadId: string;
}
export interface ArtifactSaveParams {
  threadId: string;
  title: string;
  type: string;
  content: string;
}
export interface ArtifactReadParams {
  artifactId: string;
}
export interface ArtifactExportParams {
  artifactId: string;
  destPath: string;
}

export interface SetRuntimeSecretParams {
  runtimeId: string;
  secret: string;
}

export type HostStatusKind = "starting" | "ready" | "restarting" | "stopped";

// Host-side thread/workspace caches are owned by Main; the host accepts
// metadata pushes for workspace lookups (providers need rootPath).
export interface WorkspaceMetaParams {
  workspace: Workspace;
  thread?: Thread;
}
