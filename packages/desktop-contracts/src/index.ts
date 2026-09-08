import type { Thread, Workspace } from "@aether/agent-domain";

/** Renderer -> Main invoke channels. */
export const IPC = {
  appRequest: "aether:app-request",
  hostRequest: "aether:host-request",
} as const;

/** Main -> Renderer event channel. */
export const IPC_EVENTS = {
  hostEvent: "aether:host-event",
} as const;

/** ops handled directly by Main (platform metadata + native). */
export type AppRequestOp =
  | "settings/get"
  | "settings/set"
  | "workspaces/list"
  | "workspaces/create"
  | "workspaces/delete"
  | "threads/list"
  | "threads/upsert"
  | "threads/delete"
  | "threads/rename"
  | "host/push-workspaces"
  | "window/pickDirectory"
  | "window/openPath"
  | "window/revealPath"
  | "window/notify";

export interface AppSettings {
  deepseekApiKey: string;
  deepseekModel: "deepseek-chat" | "deepseek-reasoner";
  deepseekBaseUrl: string;
  codexCommand: string;
  codexModel: string;
  approvalMode: "askAlways" | "askDangerous" | "never";
  /** Orphan-mode approval timeout in minutes (Background Run); 0 = wait forever. */
  backgroundApprovalTimeoutMinutes: number;
  ui: {
    surfaceWidth: number;
    lastWorkspaceId?: string;
    lastThreadId?: string;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  deepseekApiKey: "",
  deepseekModel: "deepseek-chat",
  deepseekBaseUrl: "https://api.deepseek.com",
  codexCommand: "codex",
  codexModel: "",
  approvalMode: "askDangerous",
  backgroundApprovalTimeoutMinutes: 30,
  ui: { surfaceWidth: 420 },
};

/** app-request payload/result shapes. */
export interface WorkspacesListResult {
  workspaces: Workspace[];
}
export interface WorkspacesCreateParams {
  name: string;
  rootPath: string;
}
export interface ThreadsListParams {
  workspaceId?: string;
}
export interface ThreadsListResult {
  threads: Thread[];
}
export interface ThreadsUpsertParams {
  thread: Thread;
}
export interface ThreadsRenameParams {
  threadId: string;
  title: string;
}

/** Envelope for host notifications forwarded to the renderer. */
export interface HostEventEnvelope {
  kind:
    | "runtimeEvent"
    | "approvalRequested"
    | "approvalResolved"
    | "runStateUpdated"
    | "hostStatus"
    | "terminalOutput"
    | "terminalExit";
  payload: unknown;
}

/** The bridge exposed by preload (implemented via contextBridge). */
export interface AetherBridge {
  appRequest(op: AppRequestOp, payload?: unknown): Promise<unknown>;
  hostRequest(op: string, payload?: unknown): Promise<unknown>;
  onHostEvent(cb: (envelope: HostEventEnvelope) => void): () => void;
}
