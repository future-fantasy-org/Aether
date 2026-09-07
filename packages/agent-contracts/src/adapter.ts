import type {
  AgentItem,
  RuntimeCapabilities,
} from "@aether/agent-domain";
import type { ApprovalRequest, ApprovalResponse } from "./approval.js";
import type { RuntimeEvent } from "./events.js";

export interface RuntimeInfo {
  runtimeId: string;
  name: string;
  version: string;
  description: string;
}

export type ApprovalMode = "askAlways" | "askDangerous" | "never";

export interface CreateThreadRequest {
  threadId: string; // Aether thread id
  cwd: string;
  model?: string;
  approvalMode?: ApprovalMode;
}

export interface AgentThreadSummary {
  externalThreadId: string;
  title: string;
  updatedAt: string;
  runtimeId: string;
}

export interface ThreadSnapshot {
  externalThreadId: string;
  title: string;
  items: AgentItem[];
  lastSequence: number;
}

export interface StartRunRequest {
  threadId: string;
  externalThreadId: string;
  runId: string;
  text: string;
}

export interface SteerRequest {
  threadId: string;
  externalThreadId: string;
  text: string;
}

export interface Disposable {
  dispose(): void;
}

/**
 * The single seam where runtime differences stop (arch.md §21/§7).
 * UI never sees beyond this interface.
 */
export interface AgentRuntimeAdapter {
  readonly runtimeId: string;
  readonly backendId: string;

  getInfo(): Promise<RuntimeInfo>;
  getCapabilities(): Promise<RuntimeCapabilities>;

  /** Start transport and perform initialize handshake. */
  connect(secret?: string): Promise<void>;
  disconnect(): Promise<void>;

  listThreads(): Promise<AgentThreadSummary[]>;
  createThread(req: CreateThreadRequest): Promise<{ externalThreadId: string }>;
  readThread(externalThreadId: string): Promise<ThreadSnapshot>;

  /** Fire a run; events arrive via subscribe(). */
  startRun(req: StartRunRequest): Promise<void>;
  interruptRun(externalThreadId: string): Promise<void>;
  steerRun?(req: SteerRequest): Promise<void>;

  respondApproval(res: ApprovalResponse & { raw: ApprovalRequest }): Promise<void>;

  subscribe(listener: (event: RuntimeEvent) => void): Disposable;
  dispose(): void;
}
