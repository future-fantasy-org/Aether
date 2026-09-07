# Aether MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 arch.md 定义的 Aether MVP：Runtime 无关的 Agent 桌面工作台，联通 Codex App Server 与内置 DeepSeek Harness 双 runtime。

**Architecture:** Sidecar 架构（spec §1）：Electron Renderer ←IPC→ Electron Main ←stdio JSON-RPC→ Agent Execution Host（独立 Node 进程）←stdio JSON-RPC→ codex app-server / deepseek-harness。事件单向流：Runtime → Adapter(normalize) → Host → Main → Renderer → Projection → Timeline。

**Tech Stack:** pnpm workspace / TypeScript / Vitest / Electron Forge + Vite / React / Tailwind / Zustand / TanStack Query / Zod / Monaco / xterm.js / node-pty

**Spec:** `docs/superpowers/specs/2026-09-08-aether-mvp-design.md`

**约定（全计划一致，不得偏离）：**
- 所有包名 `@aether/*`；app 为 `apps/desktop`（`aether-desktop`）
- 所有 JSON-RPC 消息为 JSONL（每行一条 JSON），协议版本 `2.0`
- ID 生成统一 `crypto.randomUUID()`
- 测试框架 Vitest；每包 `vitest.config.ts` + `src/**/*.test.ts` 就近放置
- 提交信息 conventional commits（feat/test/chore/docs）
- 本机已验证事实：`codex` CLI 0.144.1（`codex app-server` 子进程，JSON-RPC over stdio，需先 `initialize`）；审批反向请求方法 `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` / `item/permissions/requestApproval`，决策 `accept|acceptForSession|decline|cancel`；`AskForApproval = "untrusted"|"on-request"|"never"`；协议 TS 生成物在 `/tmp/codex-ts`

---

## Stage 0 — Monorepo 基座

### Task 0.1: 工作区脚手架

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.gitignore`, `.npmrc`

- [ ] **Step 1: 创建根配置**

`pnpm-workspace.yaml`:
```yaml
packages:
  - apps/*
  - packages/*
```

`package.json`:
```json
{
  "name": "aether",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "build": "pnpm -r --filter '!aether-desktop' run build",
    "test": "pnpm -r --filter '!aether-desktop' run test",
    "typecheck": "pnpm -r run typecheck",
    "dev": "pnpm --filter aether-desktop run dev"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

`.npmrc`:
```
shamefully-hoist=false
auto-install-peers=true
```

`.gitignore`: `node_modules/ dist/ out/ .vite/ *.tsbuildinfo .DS_Store coverage/`

- [ ] **Step 2: 安装并验证**

Run: `pnpm install`
Expected: 生成 lockfile，无错误。

- [ ] **Step 3: Commit** — `chore: scaffold pnpm monorepo`

---

## Stage 1 — 契约与领域

### Task 1.1: `@aether/agent-domain` 领域模型

**Files:**
- Create: `packages/agent-domain/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/ids.ts`, `src/workspace.ts`, `src/thread.ts`, `src/run.ts`, `src/item.ts`, `src/artifact.ts`, `src/capability.ts`, `src/index.ts`
- Test: `src/run.test.ts`, `src/capability.test.ts`

- [ ] **Step 1: 包配置**（后续所有包同构，只列差异）

`package.json` 关键字段：
```json
{
  "name": "@aether/agent-domain",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "zod": "^3.23.0" }
}
```
`tsconfig.json`: extends 根 base，`include: ["src"]`，`outDir: "dist"`。devDependency 依赖根提升的 typescript/vitest。

- [ ] **Step 2: `src/ids.ts`**

```ts
export type Id = string;
export const newId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
// 用法: newId("ws") / newId("th") / newId("run") / newId("item") / newId("art") / newId("evt") / newId("apr")
```

- [ ] **Step 3: `src/workspace.ts`**

```ts
import { z } from "zod";

export const WorkspaceBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), rootPath: z.string() }),
  z.object({ kind: z.literal("remote"), backendId: z.string(), externalId: z.string() }),
  z.object({ kind: z.literal("repository"), url: z.string(), branch: z.string().optional() }),
  z.object({ kind: z.literal("managed"), providerId: z.string(), externalId: z.string() }),
]);
export type WorkspaceBinding = z.infer<typeof WorkspaceBindingSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  binding: WorkspaceBindingSchema,
  settings: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
```

- [ ] **Step 4: `src/thread.ts`**

```ts
import { z } from "zod";

export const RuntimeBindingSchema = z.object({
  runtimeId: z.string(),          // "codex" | "deepseek" | future
  backendId: z.string(),          // "codex-local" | "deepseek-local" | future
  externalThreadId: z.string().optional(),
  runtimeVersion: z.string().optional(),
  protocolVersion: z.string().optional(),
});
export type RuntimeBinding = z.infer<typeof RuntimeBindingSchema>;

export const ThreadSchema = z.object({
  id: z.string(),                 // Aether Thread ID（th_ 前缀），非 runtime id
  workspaceId: z.string(),
  title: z.string(),
  runtimeBinding: RuntimeBindingSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean().default(false),
});
export type Thread = z.infer<typeof ThreadSchema>;
```

- [ ] **Step 5: `src/run.ts`**

```ts
import { z } from "zod";

export const RunStatusSchema = z.enum([
  "QUEUED", "STARTING", "RUNNING", "WAITING_TOOL", "WAITING_APPROVAL",
  "COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED", "DISCONNECTED",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  status: RunStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  error: z.string().optional(),
});
export type Run = z.infer<typeof RunSchema>;

/** 状态机合法迁移表（run.ts 导出，projection/host 共用） */
export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  QUEUED: ["STARTING", "CANCELLED", "FAILED"],
  STARTING: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: ["WAITING_TOOL", "WAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED", "DISCONNECTED"],
  WAITING_TOOL: ["RUNNING", "FAILED", "CANCELLED", "INTERRUPTED", "DISCONNECTED"],
  WAITING_APPROVAL: ["RUNNING", "FAILED", "CANCELLED", "INTERRUPTED", "DISCONNECTED"],
  COMPLETED: [], FAILED: [], CANCELLED: [], INTERRUPTED: [], DISCONNECTED: [],
};
export const canTransition = (from: RunStatus, to: RunStatus): boolean =>
  from === to || RUN_TRANSITIONS[from].includes(to);
```

- [ ] **Step 6: `src/item.ts`** — 14 种 AgentItem（Zod discriminatedUnion）

```ts
import { z } from "zod";

const base = z.object({ id: z.string(), threadId: z.string(), runId: z.string().optional(), createdAt: z.string() });

export const AgentItemSchema = z.discriminatedUnion("type", [
  base.extend({ type: z.literal("user_message"), text: z.string() }),
  base.extend({ type: z.literal("agent_message"), text: z.string(), streaming: z.boolean().default(false) }),
  base.extend({ type: z.literal("reasoning_summary"), text: z.string(), streaming: z.boolean().default(false) }),
  base.extend({ type: z.literal("plan"), steps: z.array(z.object({ text: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })) }),
  base.extend({ type: z.literal("tool_call"), tool: z.string(), input: z.string().optional(), output: z.string().optional(), status: z.enum(["running", "completed", "failed"]) }),
  base.extend({ type: z.literal("command"), command: z.string(), output: z.string().default(""), exitCode: z.number().optional(), status: z.enum(["running", "completed", "failed"]) }),
  base.extend({ type: z.literal("file_change"), path: z.string(), changeType: z.enum(["added", "modified", "deleted"]), additions: z.number().default(0), deletions: z.number().default(0), patch: z.string().optional() }),
  base.extend({ type: z.literal("browser"), action: z.string(), detail: z.string().optional() }),
  base.extend({ type: z.literal("search"), query: z.string(), results: z.number().optional() }),
  base.extend({ type: z.literal("approval"), approvalId: z.string(), title: z.string(), detail: z.string().optional(), risk: z.enum(["low", "medium", "high"]), decision: z.enum(["pending", "approved_once", "approved_session", "rejected", "cancelled"]).default("pending") }),
  base.extend({ type: z.literal("artifact"), artifactId: z.string(), title: z.string(), artifactType: z.string() }),
  base.extend({ type: z.literal("sub_agent"), agent: z.string(), status: z.string() }),
  base.extend({ type: z.literal("error"), message: z.string(), fatal: z.boolean().default(false) }),
  base.extend({ type: z.literal("notice"), message: z.string() }),
]);
export type AgentItem = z.infer<typeof AgentItemSchema>;
export type AgentItemType = AgentItem["type"];
```

- [ ] **Step 7: `src/artifact.ts`、`src/capability.ts`**

```ts
// artifact.ts
import { z } from "zod";
export const ArtifactTypeSchema = z.enum(["markdown", "code", "pdf", "excel", "image", "report", "text"]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;
export const ArtifactSchema = z.object({
  id: z.string(),
  type: ArtifactTypeSchema,
  title: z.string(),
  location: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local"), path: z.string() }),
    z.object({ kind: z.literal("remote"), backendId: z.string(), url: z.string() }),
  ]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
```

```ts
// capability.ts
import { z } from "zod";
export const RuntimeCapabilitiesSchema = z.object({
  plan: z.boolean(), shell: z.boolean(), files: z.boolean(), mcp: z.boolean(),
  subAgent: z.boolean(), approval: z.boolean(), steer: z.boolean(), fork: z.boolean(),
  interrupt: z.boolean(), reasoning: z.boolean(),
});
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

export const BackendCapabilitiesSchema = z.object({
  backgroundRun: z.boolean(), persistentWorkspace: z.boolean(), remoteTerminal: z.boolean(),
  browser: z.boolean(), fileSync: z.boolean(), artifactDownload: z.boolean(),
});
export type BackendCapabilities = z.infer<typeof BackendCapabilitiesSchema>;

export const effectiveCapabilities = (
  runtime: RuntimeCapabilities,
  backend: BackendCapabilities,
): RuntimeCapabilities => ({
  plan: runtime.plan, shell: runtime.shell && !backend.remoteTerminal ? true : runtime.shell,
  files: runtime.files, mcp: runtime.mcp, subAgent: runtime.subAgent,
  approval: runtime.approval, steer: runtime.steer, fork: runtime.fork,
  interrupt: runtime.interrupt, reasoning: runtime.reasoning,
});
```

- [ ] **Step 8: `src/index.ts` 导出全部 + 编写测试**

`src/run.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { canTransition } from "./run.js";
describe("run state machine", () => {
  it("allows RUNNING -> WAITING_APPROVAL", () => expect(canTransition("RUNNING", "WAITING_APPROVAL")).toBe(true));
  it("rejects COMPLETED -> RUNNING", () => expect(canTransition("COMPLETED", "RUNNING")).toBe(false));
  it("allows self transition", () => expect(canTransition("RUNNING", "RUNNING")).toBe(true));
});
```
`src/capability.test.ts` 验证 `effectiveCapabilities` 交集语义。

- [ ] **Step 9: 运行测试** — Run: `pnpm --filter @aether/agent-domain test`，Expected: PASS
- [ ] **Step 10: Commit** — `feat(domain): workspace/thread/run/item/artifact/capability models`

### Task 1.2: `@aether/agent-contracts` 协议契约

**Files:**
- Create: `packages/agent-contracts/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `src/events.ts`, `src/approval.ts`, `src/hostApi.ts`, `src/jsonrpc.ts`, `src/adapter.ts`, `src/index.ts`
- Test: `src/jsonrpc.test.ts`

- [ ] **Step 1: `src/events.ts`** — RuntimeEvent

```ts
import { z } from "zod";

export const RuntimeEventTypeSchema = z.enum([
  "thread.started", "thread.titleUpdated",
  "run.started", "run.completed", "run.failed", "run.cancelled", "run.interrupted",
  "message.delta", "message.completed",
  "reasoning.delta", "reasoning.completed",
  "plan.updated",
  "tool.started", "tool.completed",
  "command.started", "command.output", "command.completed",
  "filechange.detected", "filechange.patch",
  "approval.requested", "approval.resolved",
  "error", "notice",
]);
export type RuntimeEventType = z.infer<typeof RuntimeEventTypeSchema>;

export const RuntimeEventSchema = z.object({
  eventId: z.string(),
  sequence: z.number().int(),
  timestamp: z.string(),
  runtimeId: z.string(),
  backendId: z.string(),
  threadId: z.string(),          // Aether thread id
  runId: z.string().optional(),
  type: RuntimeEventTypeSchema,
  payload: z.unknown(),
  raw: z.unknown().optional(),
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
```

payload 各类型（同文件导出 interface，供 adapter/projection 使用）：

```ts
export interface MessageDeltaPayload { itemId: string; delta: string }
export interface MessageCompletedPayload { itemId: string; text: string }
export interface ReasoningDeltaPayload { itemId: string; delta: string }
export interface PlanUpdatedPayload { itemId: string; steps: Array<{ text: string; status: "pending" | "in_progress" | "completed" }> }
export interface ToolStartedPayload { itemId: string; tool: string; input?: string }
export interface ToolCompletedPayload { itemId: string; tool: string; output?: string; ok: boolean }
export interface CommandStartedPayload { itemId: string; command: string }
export interface CommandOutputPayload { itemId: string; delta: string }
export interface CommandCompletedPayload { itemId: string; exitCode: number | null }
export interface FileChangeDetectedPayload { itemId: string; path: string; changeType: "added" | "modified" | "deleted" }
export interface FileChangePatchPayload { itemId: string; additions: number; deletions: number; patch: string }
export interface ErrorPayload { message: string; fatal: boolean }
export interface NoticePayload { message: string }
```

- [ ] **Step 2: `src/approval.ts`**

```ts
import { z } from "zod";

export const ApprovalKindSchema = z.enum(["command", "fileChange", "permission"]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalRequestSchema = z.object({
  approvalId: z.string(),       // apr_ 前缀，Aether 生成
  threadId: z.string(),
  runId: z.string().optional(),
  runtimeId: z.string(),
  backendId: z.string(),
  kind: ApprovalKindSchema,
  title: z.string(),            // 如 "Run command" / "Apply patch"
  detail: z.string().optional(),// 命令行 / 文件列表 / 权限说明
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  createdAt: z.string(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionValueSchema = z.enum(["approved_once", "approved_session", "rejected", "cancelled"]);
export type ApprovalDecisionValue = z.infer<typeof ApprovalDecisionValueSchema>;

export interface ApprovalResponse { approvalId: string; decision: ApprovalDecisionValue }
```

风险评级规则（adapter 使用）：`rm -rf`/`sudo`/写系统路径 → high；其他 shell/写文件 → medium；只读权限 → low。

- [ ] **Step 3: `src/adapter.ts`** — AgentRuntimeAdapter 接口（arch §21 扩展 steer）

```ts
import type { RuntimeCapabilities } from "@aether/agent-domain";
import type { ApprovalResponse, ApprovalRequest } from "./events.js"; // approval.js
import type { RuntimeEvent } from "./events.js";

export interface RuntimeInfo { runtimeId: string; name: string; version: string; description: string }
export interface CreateThreadRequest { threadId: string; cwd: string; model?: string; approvalMode?: "askAlways" | "askDangerous" | "never" }
export interface AgentThreadSummary { externalThreadId: string; title: string; updatedAt: string; runtimeId: string }
export interface ThreadSnapshot { externalThreadId: string; title: string; items: AgentItem[]; lastSequence: number }
export interface StartRunRequest { threadId: string; externalThreadId: string; runId: string; text: string }
export interface SteerRequest { threadId: string; externalThreadId: string; text: string }
export type Disposable = { dispose(): void };

export interface AgentRuntimeAdapter {
  readonly runtimeId: string;
  readonly backendId: string;
  getInfo(): Promise<RuntimeInfo>;
  getCapabilities(): Promise<RuntimeCapabilities>;
  connect(secret?: string): Promise<void>;              // 启动 transport + initialize
  disconnect(): Promise<void>;
  listThreads(): Promise<AgentThreadSummary[]>;
  createThread(req: CreateThreadRequest): Promise<{ externalThreadId: string }>;
  readThread(externalThreadId: string): Promise<ThreadSnapshot>;
  startRun(req: StartRunRequest): Promise<void>;        // 事件经 subscribe 推送
  interruptRun(externalThreadId: string): Promise<void>;
  steerRun?(req: SteerRequest): Promise<void>;
  respondApproval(res: ApprovalResponse & { raw: ApprovalRequest }): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): Disposable;
  dispose(): void;
}
```
注意：`ThreadSnapshot.items` 引用 `AgentItem`（from `@aether/agent-domain`），文件顶部 `import type { AgentItem } from "@aether/agent-domain";`。

- [ ] **Step 4: `src/jsonrpc.ts`** — JSONL JSON-RPC 2.0 peer（host/harness/transport 共用）

```ts
export interface JsonRpcMessage { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export interface PeerStreams { write(data: string): void; onData(cb: (line: string) => void): void; onClose(cb: () => void): void }

export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private requestHandler?: (method: string, params: unknown) => Promise<unknown>;
  private notificationHandler?: (method: string, params: unknown) => void;
  constructor(private streams: PeerStreams) {
    this.streams.onData((line) => this.handleLine(line));
  }
  onRequest(h: (method: string, params: unknown) => Promise<unknown>) { this.requestHandler = h }
  onNotification(h: (method: string, params: unknown) => void) { this.notificationHandler = h }
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params?: unknown) { this.send({ jsonrpc: "2.0", method, params }) }
  respond(id: number | string, result: unknown) { this.send({ jsonrpc: "2.0", id, result }) }
  respondError(id: number | string, code: number, message: string) { this.send({ jsonrpc: "2.0", id, error: { code, message } }) }
  private send(msg: JsonRpcMessage) { this.streams.write(JSON.stringify(msg) + "\n") }
  private handleLine(line: string) {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method && msg.id !== undefined && msg.id !== null) {        // server -> client request
      this.requestHandler?.(msg.method, msg.params)
        .then((r) => this.respond(msg.id!, r))
        .catch((e) => this.respondError(msg.id!, -32000, String(e?.message ?? e)));
    } else if (msg.method) { this.notificationHandler?.(msg.method, msg.params) }
    else if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
    }
  }
}

// 便捷：把 Node child process / stream 适配为 PeerStreams
export function childProcessStreams(cp: { stdin: { write(s: string): boolean }; stdout: { on(ev: "data", cb: (b: Buffer) => void): void }; on(ev: "close", cb: () => void): void }): PeerStreams {
  let buffer = "";
  return {
    write: (s) => void cp.stdin.write(s),
    onData: (cb) => cp.stdout.on("data", (b: Buffer) => {
      buffer += b.toString("utf8");
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) { cb(buffer.slice(0, i)); buffer = buffer.slice(i + 1) }
    }),
    onClose: (cb) => cp.on("close", cb),
  };
}
```

- [ ] **Step 5: `src/hostApi.ts`** — Host RPC 方法名/参数类型（TypeScript interface，Zod 校验运行时按需）

按 spec §4 全量定义方法名常量与 payload 类型：`HOST_METHODS`（host/ping、host/shutdown、host/listRuntimes、host/listBackends、host/capabilities、workspace/list、workspace/create、thread/list、thread/create、thread/rename、thread/archive、thread/read、thread/select、run/start、run/interrupt、run/steer、approval/respond、fs/list、fs/read、fs/write、fs/stat、terminal/create、terminal/write、terminal/resize、terminal/dispose、artifact/list、artifact/read、artifact/export、settings/setRuntimeSecret）与 `HOST_NOTIFICATIONS`（runtimeEvent、approvalRequested、approvalResolved、runStateUpdated、hostStatus、terminalOutput、terminalExit）。每个方法对应 `Params`/`Result` interface（与 host 实现一一对应，见 Task 4.1）。

- [ ] **Step 6: jsonrpc 单测**

`src/jsonrpc.test.ts`: 用内存 `PeerStreams`（两 peer 背靠背）测试：request/response 往返、server→client request 回调、notification 分发、错误拒绝、半行分包（拆两半写入）。

- [ ] **Step 7: 运行测试 + Commit** — `feat(contracts): runtime events, approval, adapter interface, jsonrpc peer`

---

## Stage 2 — 纯逻辑包

### Task 2.1: `@aether/agent-projection`

**Files:**
- Create: `packages/agent-projection/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `src/state.ts`, `src/projectEvent.ts`, `src/projectSnapshot.ts`, `src/index.ts`
- Test: `src/projectEvent.test.ts`

- [ ] **Step 1: `src/state.ts`** — View Model

```ts
import type { AgentItem, Run } from "@aether/agent-domain";
import type { ApprovalRequest } from "@aether/agent-contracts";

export interface ThreadProjection {
  threadId: string;
  items: AgentItem[];                 // 有序时间线（已合并流式）
  runs: Record<string, Run>;
  activeRunId: string | undefined;
  pendingApprovals: ApprovalRequest[];
  lastSequence: number;
  error: string | undefined;
}

export const emptyProjection = (threadId: string): ThreadProjection => ({
  threadId, items: [], runs: {}, activeRunId: undefined, pendingApprovals: [], lastSequence: 0, error: undefined,
});
```

- [ ] **Step 2: `src/projectEvent.ts`** — 纯函数 reducer（核心逻辑，完整实现）

规则：
1. `sequence <= lastSequence` 的事件丢弃（幂等重放）
2. `message.delta/reasoning.delta`：找同 `payload.itemId` 的 item；存在且 streaming → 追加文本；不存在 → 新建 streaming item
3. `message.completed/reasoning.completed`：置 final text，`streaming=false`
4. `plan.updated`：按 itemId upsert plan item（整体替换 steps）
5. `command.started` → 新建 running CommandItem；`command.output` 追加 output；`command.completed` 置 exitCode + status（exitCode 0→completed，非 0→failed，null→completed）
6. `tool.started/tool.completed`：upsert ToolCallItem
7. `filechange.detected` → 新建 FileChangeItem；`filechange.patch` → 更新同 itemId 的 additions/deletions/patch
8. `approval.requested` → push `ApprovalRequest` 到 pendingApprovals + 新建 pending ApprovalItem；`approval.resolved` → 从 pendingApprovals 移除 + 更新 ApprovalItem.decision
9. run 事件：upsert Run 状态（用 `canTransition` 守护，非法迁移忽略）；`run.started` 设 activeRunId；终态清除 activeRunId
10. `error`：fatal → 追加 ErrorItem + 设 projection.error；否则只加 ErrorItem
11. `notice`：追加 NoticeItem
12. 所有新 item `createdAt` 取事件 timestamp，`threadId` 取事件 threadId，`runId` 取事件 runId
13. 不可变更新（返回新对象）

- [ ] **Step 3: `src/projectSnapshot.ts`**

```ts
export function projectSnapshot(prev: ThreadProjection, snapshot: { items: AgentItem[]; lastSequence: number }): ThreadProjection {
  // prev 中的流式未闭合 item 被 snapshot 同 id 覆盖；其余 prev item 保留在前、snapshot 在后（重放场景 prev 通常为空）
}
```

- [ ] **Step 4: 测试**（完整写出，覆盖 spec §11 全部规则）

```ts
// 代表性用例（全部必须存在）：
it("merges streaming message deltas into one item")
it("finalizes message on completed")
it("drops events with stale sequence")
it("builds command item lifecycle: started -> output -> completed(0)")
it("marks command failed on non-zero exit")
it("upserts plan steps")
it("aggregates filechange patch stats")
it("adds and resolves pending approval")
it("tracks run status transitions, ignores illegal ones")
it("appends fatal error item and sets projection.error")
```

- [ ] **Step 5: 运行测试 + Commit** — `feat(projection): event -> timeline view model reducer`

### Task 2.2: `@aether/workspace-provider`

**Files:**
- Create: `packages/workspace-provider/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `src/types.ts`, `src/localProvider.ts`, `src/index.ts`
- Test: `src/localProvider.test.ts`

- [ ] **Step 1: `src/types.ts`**

```ts
export interface FileEntry { name: string; path: string; kind: "file" | "directory"; size?: number; modifiedAt?: string }
export interface FileContent { path: string; content: string; truncated: boolean }
export interface FileStat { path: string; kind: "file" | "directory"; size: number; modifiedAt: string }
export interface WorkspaceFileProvider {
  list(path: string): Promise<FileEntry[]>;
  read(path: string, opts?: { maxBytes?: number }): Promise<FileContent>;
  write(path: string, content: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
}
```

- [ ] **Step 2: `src/localProvider.ts`** — `LocalFileProvider(root: string)`：resolve 后必须仍在 root 内（防越界，`path.relative` 检查不以 `..` 开头）；read 默认 maxBytes 512KB 截断置 truncated；list 排序（目录在前、名称序）。

- [ ] **Step 3: 测试** — tmpdir：list/read/write/stat、路径越界抛错、截断标记。
- [ ] **Step 4: Commit** — `feat(workspace): local file provider with sandboxed paths`

### Task 2.3: `@aether/terminal-provider`

**Files:**
- Create: `packages/terminal-provider/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `src/types.ts`, `src/localPty.ts`, `src/index.ts`
- Test: `src/localPty.test.ts`

- [ ] **Step 1: `src/types.ts`**

```ts
export interface TerminalSession {
  readonly id: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  onOutput(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
}
export interface TerminalProvider { create(cwd?: string): Promise<TerminalSession>; get(id: string): TerminalSession | undefined; dispose(id: string): void }
```

- [ ] **Step 2: `src/localPty.ts`** — node-pty 实现：`pty.spawn(process.env.SHELL ?? "/bin/zsh", [], { name: "xterm-256color", cwd, cols: 80, rows: 24 })`；输出回调聚合。

- [ ] **Step 3: 测试** — 创建会话、`echo hello` 输出包含 `hello`、dispose 触发 exit。（若 node-pty 安装失败：实现 `PipeTerminalProvider` 后备——`child_process.spawn(shell, ["-c"...])`? 不做交互；仅此降级并标注。）

- [ ] **Step 4: Commit** — `feat(terminal): pty-backed terminal provider`

### Task 2.4: `@aether/artifact-provider`

**Files:**
- Create: `packages/artifact-provider/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `src/types.ts`, `src/localArtifacts.ts`, `src/index.ts`
- Test: `src/localArtifacts.test.ts`

- [ ] **Step 1: `src/types.ts`**

```ts
import type { Artifact } from "@aether/agent-domain";
export interface ArtifactProvider {
  save(threadId: string, artifact: Omit<Artifact, "id" | "createdAt" | "location"> & { content: string }): Promise<Artifact>;
  list(threadId: string): Promise<Artifact[]>;
  read(artifactId: string): Promise<{ artifact: Artifact; content: string } | undefined>;
  export(artifactId: string, destPath: string): Promise<Artifact>;
}
```

- [ ] **Step 2: `src/localArtifacts.ts`** — 存储目录 `~/.aether/artifacts/<threadId>/<artifactId>` + sidecar `<id>.json` 元数据；type 由扩展名/参数推断；export = 复制到 destPath 并返回更新 location 的 Artifact。
- [ ] **Step 3: 测试 + Commit** — `feat(artifacts): local artifact store`

---

## Stage 3 — Runtimes

### Task 3.1: DeepSeek Harness 参考实现（`@aether/runtime-deepseek` 内 `harness/`）

**Files:**
- Create: `packages/runtime-deepseek/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `src/index.ts`（adapter，Task 3.2）
- Create: `harness/bin/deepseek-harness.ts`（入口 `#!/usr/bin/env node`）
- Create: `harness/src/protocol.ts`, `harness/src/agentLoop.ts`, `harness/src/tools.ts`, `harness/src/approvals.ts`, `harness/src/sessions.ts`, `harness/src/deepseekClient.ts`, `harness/src/server.ts`
- Test: `harness/src/agentLoop.test.ts`, `harness/src/sessions.test.ts`, `harness/src/server.test.ts`（fake SSE）

包 `package.json` 附加：`"bin": { "deepseek-harness": "./dist/harness/bin/deepseek-harness.js" }`；adapter 与 harness 共享 `src/shared/protocolEvents.ts`（事件 payload 类型复用 `@aether/agent-contracts`）。

- [ ] **Step 1: `harness/src/deepseekClient.ts`** — OpenAI 兼容流式客户端

```ts
export interface DeepSeekConfig { apiKey: string; baseUrl: string; model: string }
export interface StreamHandlers { onContentDelta(s: string): void; onReasoningDelta(s: string): void; onToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): void }
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; tool_call_id?: string; reasoning_content?: string }

export async function streamChat(config: DeepSeekConfig, messages: ChatMessage[], tools: unknown[], handlers: StreamHandlers, signal?: AbortSignal): Promise<{ finishReason: string | null; content: string }>
```
实现：`fetch(config.baseUrl + "/chat/completions", { method: "POST", headers: { Authorization: Bearer, content-type }, body: JSON.stringify({ model, messages, tools, stream: true }), signal })`；逐行读 SSE（`data: ` 前缀，`[DONE]` 结束）；delta.content → onContentDelta；delta.reasoning_content → onReasoningDelta；delta.tool_calls 累积（按 index 拼接 id/function.name/function.arguments）；finish 后聚合返回。非 2xx → 抛含 body 文本错误。

- [ ] **Step 2: `harness/src/tools.ts`** — 工具实现与 schema

工具（全部限制在 session cwd 内，复用 workspace-provider 的越界检查逻辑——直接依赖 `@aether/workspace-provider`）：
- `read_file(path)` → content（截断 64KB）
- `write_file(path, content)` → ok
- `edit_file(path, old_string, new_string)` → 精确替换一次，未命中报错
- `glob(pattern)` → 匹配路径列表（上限 200）
- `grep(query, glob?)` → 匹配行（上限 100）
- `run_shell(command)` → `{ stdout, stderr, exitCode }`（`child_process.execFile(shell, ["-c", command], { cwd, timeout: 120_000, maxBuffer: 1MB })`）

`toolSchemas()` 返回 OpenAI function 定义数组。`executeTool(name, args, ctx)` 分发执行。

- [ ] **Step 3: `harness/src/approvals.ts`**

```ts
const DEFAULT_DANGEROUS = [/rm\s+-rf/, /sudo\b/, />\s*\/dev\/sd/, /mkfs/, /dd\s+if=/, /curl[^|]*\|\s*(ba)?sh/, /wget[^|]*\|\s*(ba)?sh/, /git\s+push\s+--force/];
export function shellRisk(command: string): { risk: "low" | "medium" | "high"; needsApproval: boolean } {
  // 命中 DEFAULT_DANGEROUS → high；写类命令（>、tee、sed -i、write_file 外的修改）→ medium；
  // 只读（ls/cat/grep/find/git status|diff|log）→ low。needsApproval = approvalMode !== "never" && risk !== "low"
  // approvalMode === "askAlways" 时一切 run_shell 都 needsApproval
}
```

- [ ] **Step 4: `harness/src/sessions.ts`** — JSONL 会话存储

```ts
export interface HarnessEventRecord { seq: number; ts: string; type: string; payload: unknown }
export class SessionStore {
  constructor(sessionId: string, dir?: string);  // 默认 ~/.aether/runtimes/deepseek/sessions/<id>.jsonl
  append(ev: HarnessEventRecord): void;          // 追加一行 JSON
  readAll(): HarnessEventRecord[];               // 全量（thread/read 重放）
  nextSeq(): number;
}
```

- [ ] **Step 5: `harness/src/agentLoop.ts`** — 核心（完整实现逻辑）

```ts
export interface LoopContext {
  sessionId: string;
  cwd: string;
  model: string;
  approvalMode: "askAlways" | "askDangerous" | "never";
  apiKey: string;
  baseUrl: string;
  emit(ev: { type: string; payload: unknown }): void;   // 内部事件（server.ts 负责包 RuntimeEvent 壳）
  requestApproval(req: { kind: "command" | "fileChange"; title: string; detail: string; risk: "low" | "medium" | "high" }): Promise<"approved_once" | "approved_session" | "rejected" | "cancelled">;
  interrupted(): boolean;                                // 轮询中断标志
}
export async function runTurn(ctx: LoopContext, userText: string): Promise<void>
```

逻辑：
1. messages 初始化：system prompt（"You are a coding agent working in <cwd>. Use tools to inspect and modify files. Prefer edit_file for changes. Be concise."）+ 历史（从 SessionStore 恢复的 messages 数组——session 文件额外记录 `role` 消息行，重放时重建）
2. emit `run.started`；循环最多 25 次迭代：
   a. `streamChat`：content delta → emit `message.delta`；reasoning delta → emit `reasoning.delta`；工具调用 → 逐个 emit `tool.started` → 执行：
      - `run_shell`：shellRisk 判定；needsApproval → emit `approval.requested` + `ctx.requestApproval`（reject → 工具结果为错误字符串，继续对话）；通过 → 执行
      - `write_file`/`edit_file`：approvalMode 非 never 且路径在 cwd 外（被拒绝时）→ fileChange 审批；cwd 内 → 直接执行（MVP 从简，risk medium 仅 run_shell 审批）
      - emit `command.started/output*/completed`（仅 run_shell）与 `tool.completed`
      - write/edit 后 emit `filechange.detected`（changeType：新文件 added，否则 modified）
   b. 无工具调用 → emit `message.completed`（终文本），循环结束
   c. 把 assistant 消息（含 tool_calls）与 tool 结果追加进 messages 并持久化 session
3. 中断（interrupted()）→ emit `run.cancelled`，停止
4. 完成 → emit `run.completed`
5. 异常 → emit `run.failed`（ErrorPayload：API 错误、无效 key 401 → message "DeepSeek API auth failed (check API key in settings)"）

会话内 turn 间保留 messages（多轮上下文）；session 行格式：`{ seq, ts, kind: "event" | "message", ... }`。

- [ ] **Step 6: `harness/src/protocol.ts` + `harness/src/server.ts`** — JSON-RPC 服务

方法（stdio，用 `@aether/agent-contracts` 的 JsonRpcPeer + childProcessStreams(stdin/stdout 直接 process 对象适配)）：
- `initialize { clientInfo, apiKey?, baseUrl?, model? }` → `{ harnessVersion }`（apiKey 内存保存）
- `thread/start { threadId, cwd, model?, approvalMode? }` → `{ externalThreadId = sessionId }`（创建 SessionStore）
- `thread/list {}` → `[{ externalThreadId, title, updatedAt }]`（扫描 sessions 目录）
- `thread/read { threadId }` → `{ externalThreadId, events: HarnessEventRecord[] }`
- `turn/start { threadId, runId, text }` → 异步执行 runTurn（立即返回 `{ ok: true }`），事件以通知推送
- `turn/interrupt { threadId }` → 置中断标志
- `approval/respond { approvalId, decision }` → resolve 挂起的审批 Promise

通知（→ 上层）：`runtimeEvent { eventId, sequence, timestamp, runtimeId: "deepseek", backendId: "deepseek-local", threadId, runId?, type, payload }`（server 负责从 HarnessEventRecord 包装，sequence 取 seq）。审批：`turn/start` 期间遇到审批 → server 发 server→client request `approval/request { approvalId, kind, title, detail, risk }`，等待客户端 `approval/respond` 或请求响应。

事件出口统一 `process.stdout.write(line + "\n")`；日志一律 stderr。

- [ ] **Step 7: `harness/bin/deepseek-harness.ts`** — 入口：`server.main(process.stdin, process.stdout)`，`--version` 打印版本退出。

- [ ] **Step 8: 测试**

- `deepseekClient.test.ts`：起本地 http server 返回手工 SSE 分片（含拆半 chunk、tool_calls 增量、reasoning_content），断言 handlers 收到的聚合与返回值；401 → 错误信息
- `agentLoop.test.ts`：fake `streamChat`（注入式依赖）驱动完整 turn：纯文本回复；一轮工具调用（read_file）后文本收尾；危险 shell 触发审批且 rejected 时模型收到工具错误；interrupt 生效
- `sessions.test.ts`：append/readAll/nextSeq/重放重建 messages
- `server.test.ts`：spawn 真实 harness 子进程（`tsx` 或 build 后 node），走完整 initialize→thread/start→turn/start（fake DeepSeek http server）→ 收到 runtimeEvent 序列 → thread/read 重放一致

- [ ] **Step 9: 运行测试 + Commit** — `feat(deepseek): reference harness with agent loop, tools, approvals, jsonl sessions`

### Task 3.2: DeepSeekAdapter

**Files:**
- Create: `packages/runtime-deepseek/src/adapter.ts`, `src/index.ts`
- Test: `src/adapter.test.ts`

- [ ] **Step 1: `src/adapter.ts`**

```ts
export class DeepSeekAdapter implements AgentRuntimeAdapter {
  readonly runtimeId = "deepseek";
  readonly backendId = "deepseek-local";
  // 构造: { command: string(默认 process.execPath), args: string[](默认 [harness bin js 路径]) }
  // connect(secret?): spawn harness（stdio pipe, env 无 key）→ JsonRpcPeer → initialize({apiKey: secret})
  // createThread → thread/start；startRun → turn/start（不等待完成）；interruptRun → turn/interrupt
  // steerRun: 不实现（capability.steer=false）
  // respondApproval → approval/respond
  // subscribe: peer.onNotification("runtimeEvent") → 校验 RuntimeEventSchema → listener
  // readThread → thread/read → events 中 kind=event 行经 projectEvent 相同规则转 AgentItem（复用 agent-projection: emptyProjection + reduce）
  // listThreads → thread/list
  // capabilities: { plan:false, shell:true, files:true, mcp:false, subAgent:false, approval:true, steer:false, fork:false, interrupt:true, reasoning:true }
}
```
harness bin 路径解析：`new URL("../../harness/bin/deepseek-harness.js", import.meta.url)`（build 产物）；dev 下用 tsx 包装。

- [ ] **Step 2: 测试** — spawn 真实 harness + fake DeepSeek：createThread/startRun/事件订阅/审批往返/readThread 重放。
- [ ] **Step 3: Commit** — `feat(deepseek): runtime adapter`

### Task 3.3: `@aether/runtime-codex`

**Files:**
- Create: `packages/runtime-codex/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `src/protocol/`（`codex app-server generate-ts --out` 生成物快照，commit 入库）
- Create: `src/transport.ts`, `src/mapping.ts`, `src/adapter.ts`, `src/index.ts`
- Test: `src/mapping.test.ts`, `src/adapter.test.ts`

- [ ] **Step 1: 协议快照**

Run: `codex app-server generate-ts --out packages/runtime-codex/src/protocol && pnpm -F @aether/runtime-codex exec tsc`（生成物顶部加 `// @ts-nocheck` 由脚本处理，避免严格模式报错；仅作类型参考）。

- [ ] **Step 2: `src/transport.ts`**

```ts
export interface TransportOptions { command: string; args: string[] }
export class CodexAppServerTransport {
  // spawn(command, args, { stdio: pipe })，JsonRpcPeer(childProcessStreams)
  // connect(): initialize({ clientInfo: { name: "aether", title: "Aether", version: "0.1.0" } })
  // request/notify/onNotification/onRequest 直通 peer；close() kill 子进程
  // onClose 回调：进程退出通知 adapter → DISCONNECTED
}
```
默认 `command = "codex", args = ["app-server"]`（可配置覆盖）。

- [ ] **Step 3: `src/mapping.ts`** — 纯映射函数（核心，全部导出以便单测）

```ts
// Codex ThreadItem -> AgentItem（thread/read 快照用）
export function mapThreadItem(threadId: string, item: CodexThreadItem): AgentItem | undefined
//   userMessage → user_message（取第一个 text input）
//   agentMessage → agent_message(streaming=false)
//   reasoning → reasoning_summary（join summary）
//   plan → plan（steps=[]，Codex plan item 只有 text；TurnPlanUpdated 才有 steps）
//   commandExecution → command（status 由 item.status/exitedCode 映射）
//   fileChange → file_change（changeType 由 item.changes[0].kind）
//   mcpToolCall / toolCall → tool_call
//   webSearch → search；其余 → undefined（忽略）

// ServerNotification -> RuntimeEvent[]（流式用；一个通知可能产生 0..n 个事件）
export function mapNotification(threadId: string, runId: string | undefined, method: string, params: unknown): Array<{ type: RuntimeEventType; payload: unknown }>

// turn/*（turnId → runId 映射由 adapter 维护）
// TurnStarted → run.started；TurnCompleted → run.completed（+ command.completed 收尾）
// AgentMessageDelta { itemId, delta } → message.delta
// ReasoningSummaryTextDelta / ReasoningTextDelta { itemId, delta } → reasoning.delta
// ItemCompleted(item) → 按 item 类型: agentMessage → message.completed；commandExecution → command.completed(exitCode=exitedCode)；fileChange → filechange.detected
// ItemStarted(item) → commandExecution → command.started；mcpToolCall → tool.started
// CommandExecutionOutputDelta / CommandExecOutputDelta { itemId, delta } → command.output
// FileChangePatchUpdated { itemId, additions?, deletions?, patch? } → filechange.patch
// TurnPlanUpdated { plan?: { steps: TurnPlanStep[] } } → plan.updated（step.status: pending/completed → completed 已完成映射）
// ErrorNotification { message } → error（fatal=false）
// ProcessExited / ThreadClosed → 上层处理（adapter 内部，非事件）
```

```ts
// 审批映射
export function mapApprovalRequest(method: string, params: unknown): { kind: ApprovalKind; title: string; detail: string; risk: "low"|"medium"|"high" } | undefined
//   item/commandExecution/requestApproval → kind command，detail = 命令行（params.command.command 数组 join 或 runtimeCommand），rm -rf/sudo → high
//   item/fileChange/requestApproval → kind fileChange，detail = changes 摘要（文件路径 ± 行数）
//   item/permissions/requestApproval → kind permission
export function mapDecision(decision: ApprovalDecisionValue): string
//   approved_once → "accept"；approved_session → "acceptForSession"；rejected → "decline"；cancelled → "cancel"（permission/fileChange 同形）
```

- [ ] **Step 4: `src/adapter.ts`**

```ts
export class CodexAdapter implements AgentRuntimeAdapter {
  readonly runtimeId = "codex"; readonly backendId = "codex-local";
  // connect(): transport.connect()；订阅 onNotification → mapNotification → 包 RuntimeEvent（sequence: 进程内单调计数器自 1 递增）→ listeners
  // createThread: thread/start { cwd, model?, approvalPolicy: map(mode)("askAlways"→"on-request"...) } → externalThreadId
  //   注意: MVP approvalMode 默认 "on-request"（codex 语义：模型认为需要时请求）；askDangerous→"untrusted"？不 — 简化映射: askAlways→"untrusted", askDangerous→"on-request", never→"never"
  // startRun: turn/start { threadId: external, input: [{ type: "text", text }], cwd? } ；turnId→runId 注册表；TurnStarted 通知携带 turnId → 关联 runId
  // interruptRun: turn/interrupt { threadId }
  // steerRun: turn/steer（capability.steer=true）
  // respondApproval: transport.respond(id, mapDecision()) —— approval server request 到达时经 onRequest 回调 → 生成 ApprovalRequest(apr_) → emit approval.requested 事件 + pending 表；respondApproval 查表回填
  // readThread: thread/read { threadId } → response.turns/items 经 mapThreadItem → ThreadSnapshot；lastSequence = 内部计数器
  // listThreads: thread/list → 映射 AgentThreadSummary（过滤 archived）
  // capabilities: { plan:true, shell:true, files:true, mcp:true, subAgent:true, approval:true, steer:true, fork:true, interrupt:true, reasoning:true }
  // 进程退出 onClose → emit error(fatal) + run 落 DISCONNECTED（经 host EventNormalizer）
}
```

- [ ] **Step 5: 测试**

- `mapping.test.ts`：每个 mapNotification 分支的 fixture 断言（手工 JSON，来自 /tmp/codex-ts 类型形状）
- `adapter.test.ts`：**scripted fake codex** —— 测试内起一个 Node 脚本子进程，按脚本回放预录 JSONL（initialize → thread/start → turn/start → ItemStarted/ItemCompleted/Delta 通知 → 审批 request），adapter 配置 `command: process.execPath, args: [fakeServerJs]`；断言：事件序列、run 状态、审批往返、readThread 快照。另跑一次真实冒烟 `test/smoak.real.test.ts`（`describe.skipIf(!existsSync(which codex))`）：initialize + thread/list 真进程。

- [ ] **Step 6: Commit** — `feat(codex): app-server adapter with protocol snapshot and scripted tests`

---

## Stage 4 — Agent Execution Host

### Task 4.1: `@aether/agent-runtime-host`

**Files:**
- Create: `packages/agent-runtime-host/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `src/registry.ts`, `src/connectionManager.ts`, `src/approvalRouter.ts`, `src/eventNormalizer.ts`, `src/providers.ts`, `src/host.ts`, `src/bin/aether-agent-host.ts`
- Test: `src/host.test.ts`

- [ ] **Step 1: `src/registry.ts`**

```ts
export interface RuntimeDescriptor { runtimeId: string; backendId: string; name: string; factory: () => AgentRuntimeAdapter; runtimeCapabilities: RuntimeCapabilities; backendCapabilities: BackendCapabilities }
export class RuntimeRegistry { register(d: RuntimeDescriptor): void; list(): RuntimeDescriptor[]; get(runtimeId: string, backendId: string): RuntimeDescriptor | undefined }
export function defaultRegistry(opts: { deepSeekCommand?: { command: string; args: string[] }; codexCommand?: { command: string; args: string[] } }): RuntimeRegistry
// 注册: codex/codex-local → new CodexAdapter(opts.codexCommand)；deepseek/deepseek-local → new DeepSeekAdapter(opts.deepSeekCommand)
```

- [ ] **Step 2: `src/connectionManager.ts`** — 懒连接：`(runtimeId, backendId) → { adapter, connected }`；`get(runtimeId, backendId, secret?)` 首次 `connect(secret)`；断线清理 + 重连；`disposeAll()`。

- [ ] **Step 3: `src/approvalRouter.ts`** — approvalId ↔ { adapter, rawRequest } 表；`route(res: ApprovalResponse)` → adapter.respondApproval；pending 列表查询。

- [ ] **Step 4: `src/eventNormalizer.ts`** — 订阅所有活跃 adapter 事件 → 补齐/覆写 eventId（evt_）、timestamp、sequence（per-thread 单调，取 max(last+1, event.sequence)）→ 转发 host 输出通知 `runtimeEvent`；`approval.requested` 事件同时发 `approvalRequested` 通知。

- [ ] **Step 5: `src/providers.ts`** — workspace/terminal/artifact provider 实例化（按 Workspace.binding.kind === "local" → LocalFileProvider(rootPath)；remote → 抛 "not supported in MVP"）。

- [ ] **Step 6: `src/host.ts` + bin**

`AetherHost` 类：组装上述模块 + JsonRpcPeer(process stdin/stdout)；`onRequest` 分发 hostApi 全部方法（spec §4 表）；`onNotification` 无（host 不收通知）。关键语义：

- `thread/create { workspaceId, runtimeId, backendId, title?, model?, approvalMode? }`：生成 Aether thread（th_），调 adapter.createThread，返回 Thread（runtimeBinding 填 externalThreadId）；host **不持久化**（Main 持久化）——thread/list 由 Main 提供；host 的 `thread/list` 代理各 adapter.listThreads
- `run/start { threadId, externalThreadId, runtimeId, backendId, text, runId? }` → connectionManager → adapter.startRun
- `approval/respond { approvalId, decision }` → approvalRouter
- `fs/*`、`terminal/*`，`terminal/create { workspaceId, cwd? }` → TerminalProvider.create → 后续 `terminalOutput { terminalId, data }` 通知
- `artifact/*` → provider
- `host/capabilities { runtimeId, backendId }` → effectiveCapabilities
- `settings/setRuntimeSecret { runtimeId, secret }` → 存内存 map，connectionManager 连接时注入（deepseek 用；codex 忽略）

`src/bin/aether-agent-host.ts`：`new AetherHost(...).start()`；`process.on("SIGTERM") → graceful`；日志 stderr。

- [ ] **Step 7: `src/host.test.ts`** — 注册 fake adapter（内存实现 AgentRuntimeAdapter，可编程事件/审批）驱动：capabilities、thread/create→run/start→事件通知（sequence 单调）、审批请求→approval/respond→adapter 收到 decision、fs/terminal provider 接线（tmpdir）。

- [ ] **Step 8: 冒烟脚本** `scripts/host-smoke.mjs`（dev 用）：起 host 子进程 + fake deepseek http server，完整跑一个 turn，打印事件流。
- [ ] **Step 9: Commit** — `feat(host): agent execution host with registries, approval routing, event normalization`

---

## Stage 5 — Desktop App

### Task 5.1: `apps/desktop` 脚手架 + IPC 桥

**Files:**
- Create: `apps/desktop/package.json`, `forge.config.ts`, `vite.main.config.ts`, `vite.preload.config.ts`, `vite.renderer.config.ts`, `tsconfig.json`, `index.html`
- Create: `packages/desktop-contracts/{package.json,tsconfig.json,src/index.ts}`
- Create: `src/main/index.ts`, `src/main/window.ts`, `src/preload/index.ts`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`

- [ ] **Step 1: Forge + Vite 配置**（标准模板改造）

`package.json` scripts：`"dev": "electron-forge start", "package": "electron-forge package"`；devDeps：`electron@^37`, `@electron-forge/cli`, `@electron-forge/plugin-vite`, `vite`, `react`, `react-dom`, `@vitejs/plugin-react`, `tailwindcss@^4`, `@tailwindcss/vite`, `zustand`, `@tanstack/react-query`, `zod`；deps：`@aether/*` 全部 workspace 协议 `"workspace:*"`。
`forge.config.ts`：vite plugin 三入口（main/preload/renderer）；`packagerConfig.asar` false（MVP 简化 native/子进程路径）。
`vite.renderer.config.ts`：react + tailwindcss 插件，`base: "./"`（file:// 兼容…… Forge vite 模板用 `process.env.VITE_DEV_SERVER_URL`，按模板）。

- [ ] **Step 2: `desktop-contracts/src/index.ts`**

```ts
// Renderer -> Main invoke 通道
export const IPC = {
  appRequest: "aether:app-request",     // workspace/settings/thread 元数据 CRUD（Main 直答）
  hostRequest: "aether:host-request",   // 转发 host RPC
} as const;
// Main -> Renderer 事件通道
export const IPC_EVENTS = {
  hostEvent: "aether:host-event",       // { kind: "runtimeEvent" | "approvalRequested" | "runStateUpdated" | "hostStatus" | "terminalOutput" | "terminalExit", payload: unknown }
} as const;
// app-request op 集合（Main 处理）: "settings/get" | "settings/set" | "workspaces/list" | "workspaces/create" | "workspaces/delete" | "threads/list" | "threads/upsert" | "threads/delete" | "threads/rename" | "window/openPath" | "window/revealPath" | "window/notify"
```
（host-request op = HOST_METHODS 直通。）

- [ ] **Step 3: main/preload/renderer 骨架**

`src/main/index.ts`：app ready → createWindow（1200×800, minWidth 960，`contextIsolation: true, nodeIntegration: false, preload`）；`src/preload/index.ts`：

```ts
import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("aether", {
  appRequest: (op: string, payload?: unknown) => ipcRenderer.invoke("aether:app-request", op, payload),
  hostRequest: (op: string, payload?: unknown) => ipcRenderer.invoke("aether:host-request", op, payload),
  onHostEvent: (cb: (envelope: { kind: string; payload: unknown }) => void) => {
    const l = (_e: unknown, env: { kind: string; payload: unknown }) => cb(env);
    ipcRenderer.on("aether:host-event", l);
    return () => ipcRenderer.removeListener("aether:host-event", l);
  },
});
```

renderer `App.tsx` 先渲染三栏空壳（Tailwind 布局：`grid grid-cols-[260px_1fr_0px]`，右栏可动态 360px/50%）。

- [ ] **Step 4: 验证** — `pnpm --filter aether-desktop dev` 打开窗口显示空壳。
- [ ] **Step 5: Commit** — `feat(desktop): electron forge + vite + react shell with typed ipc bridge`

### Task 5.2: Main 持久化（SQLite/JSON 回退）

**Files:**
- Create: `apps/desktop/src/main/store/types.ts`, `store/sqliteStore.ts`, `store/jsonStore.ts`, `store/index.ts`, `settings.ts`
- Test: `store/jsonStore.test.ts`（node 环境可测；sqliteStore 走同 interface 用例，`describe.skipIf(!nodeSqliteAvailable)`）

- [ ] **Step 1: `store/types.ts`**

```ts
export interface PlatformStore {
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  listWorkspaces(): Promise<Workspace[]>;
  upsertWorkspace(ws: Workspace): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  listThreads(workspaceId?: string): Promise<Thread[]>;
  upsertThread(t: Thread): Promise<void>;
  deleteThread(id: string): Promise<void>;
}
export interface AppSettings {
  deepseekApiKey: string;        // 仅设置界面写入
  deepseekModel: "deepseek-chat" | "deepseek-reasoner";
  deepseekBaseUrl: string;       // 默认 https://api.deepseek.com
  codexCommand: string;          // 默认 "codex"
  codexModel: string;            // 默认 ""（用 codex 默认）
  approvalMode: "askAlways" | "askDangerous" | "never";
  ui: { surfaceWidth: number; lastWorkspaceId?: string; lastThreadId?: string };
}
```

- [ ] **Step 2: 实现** — `sqliteStore.ts` 用 `node:sqlite`（`try { await import("node:sqlite") } catch` → fallback `jsonStore.ts`，存 `~/Library/Application Support/Aether/store.json`（`app.getPath("userData")`）；jsonStore 原子写（tmp+rename），全量内存缓存。表：settings(key,value)/workspaces/threads（JSON 列）。工厂 `createPlatformStore(userDataPath): Promise<PlatformStore>`。
- [ ] **Step 3: 测试 + Commit** — `feat(desktop): platform store with sqlite and json fallback`

### Task 5.3: Sidecar 生命周期 + IPC 桥接

**Files:**
- Create: `apps/desktop/src/main/sidecar.ts`, `src/main/ipc.ts`
- Modify: `src/main/index.ts`（接线）
- Test: `sidecar.test.ts`（spawn echo host script，测健康/重启）

- [ ] **Step 1: `sidecar.ts`**

```ts
export class HostSidecar {
  // spawn(process.execPath, [host bin js], { stdio: pipe, env })
  // JsonRpcPeer(childProcessStreams) + request/事件回调上抛
  // 启动握手: host/ping（超时 10s）
  // 崩溃: onClose → 指数退避重启（1s/2s/4s..上限 15s）→ onStatus("restarted")
  // request(op, params): 若正在重启 → reject "host restarting"
  // app quit → shutdown + kill
}
```
host bin 路径：dev 用 `packages/agent-runtime-host/dist/bin/aether-agent-host.js`（resolve 同学路径），packaged 用 resources。

- [ ] **Step 2: `ipc.ts`** — 注册 `ipcMain.handle("aether:app-request")`（查 store + workspace/thread CRUD + `window/openPath` → `shell.openPath`、`window/revealPath` → `shell.showItemInFolder`、`window/notify` → Notification）与 `ipcMain.handle("aether:host-request")` → sidecar.request；host 通知 → `webContents.send("aether:host-event", envelope)`；启动时把 settings 的 deepseekApiKey/codexCommand 经 `settings/setRuntimeSecret` + host 启动参数下发。
- [ ] **Step 3: 测试 + Commit** — `feat(desktop): host sidecar lifecycle and ipc bridging`

### Task 5.4: `@aether/agent-runtime-client` + Renderer 状态基座

**Files:**
- Create: `packages/agent-runtime-client/{package.json,tsconfig.json,src/index.ts}`
- Create: `apps/desktop/src/renderer/api/client.ts`, `stores/ui.ts`, `stores/timeline.ts`, `App.tsx` 改造
- Test: `stores/timeline.test.ts`

- [ ] **Step 1: `agent-runtime-client`** — `createAetherClient(bridge)`（bridge 接口 = preload 形状，便于测试注入）：类型化 `host.request<Op>()` 全方法 + `onRuntimeEvent` 分发；内部维护 per-thread 订阅回调表。

- [ ] **Step 2: stores**

`stores/timeline.ts`（Zustand）：
```ts
interface TimelineStore {
  projections: Record<string, ThreadProjection>;
  applyEvent(ev: RuntimeEvent): void;        // projectEvent 纯函数包装
  loadSnapshot(threadId: string, snap: { items: AgentItem[]; lastSequence: number }): void;
}
```
`stores/ui.ts`：选中 workspace/thread、surface 栈（`surfaces: Surface[]; pin/open/close`，`Surface = { id; kind: "diff"|"files"|"terminal"|"artifact"|"inspector"; title; props }`）、右栏宽度、composer 状态。

- [ ] **Step 3: App 接线** — `onHostEvent(runtimeEvent)` → timelineStore.applyEvent；`approvalRequested` → approvals store；`hostStatus` → 连接状态 banner。
- [ ] **Step 4: 测试（timeline store 用假事件序列）+ Commit** — `feat(renderer): runtime client and projection-backed stores`

### Task 5.5: 左栏 — Workspace / Threads

**Files:**
- Create: `apps/desktop/src/renderer/features/sidebar/Sidebar.tsx`, `WorkspaceList.tsx`, `ThreadList.tsx`, `NewThreadDialog.tsx`, `RuntimeBadge.tsx`
- Modify: `App.tsx`

- [ ] **Step 1: 组件行为**（TanStack Query + Radix Dialog/Select）

- `WorkspaceList`：工作区列表 + "Add Workspace"（`dialog.showOpenDialog({ properties: ["openDirectory"] })` 经 appRequest `"workspaces/create" { name, rootPath }`）；当前选中高亮
- `ThreadList`：当前 workspace 的 threads（archived 折叠）；"+" 打开 NewThreadDialog：标题 + runtime 选择（列自 `host/listRuntimes`，显示 codex/deepseek 与后端）+ model 输入（默认 settings）
- `RuntimeBadge`：thread 的 runtimeBinding → 色标（codex=绿 / deepseek=蓝）
- 点击 thread → `ui.setSelectedThread` + `thread/read` 恢复 projection（loadSnapshot）

- [ ] **Step 2: Commit** — `feat(renderer): workspace and thread sidebar`

### Task 5.6: 中栏 — Timeline + Item Renderers + 审批

**Files:**
- Create: `src/renderer/features/timeline/Timeline.tsx`, `TimelineItemView.tsx`, `renderers/{MessageRenderer,PlanRenderer,CommandRenderer,FileChangeRenderer,ApprovalRenderer,ErrorRenderer,NoticeRenderer,ArtifactRenderer,ToolCallRenderer,ReasoningRenderer}.tsx`, `registry.ts`
- Create: `src/renderer/features/approvals/ApprovalBanner.tsx`

- [ ] **Step 1: `registry.ts`** — `ItemRenderer` 注册表

```tsx
export interface ItemRendererProps<T = AgentItem> { item: T; onOpenSurface?: (s: Surface) => void }
const registry = new Map<AgentItemType, React.ComponentType<ItemRendererProps<any>>>();
export function registerRenderer(type: AgentItemType, c: any) { registry.set(type, c) }
export function getRenderer(type: AgentItemType) { return registry.get(type) ?? FallbackRenderer }
```
（各 renderer 文件内自注册，registry.ts 汇总 import。）

- [ ] **Step 2: Timeline 视觉**（arch §18 风格，非聊天气泡）

- 左侧竖线 + 节点标记：USER（人形/标签）、PLAN（checkbox 列表 ✓/○/进行中 spinner）、COMMAND（`$ npm test` + 可折叠输出 + ✓/✗ + exitCode）、EDIT/READ（文件名 + +N/-M，点击 → 打开 diff surface）、AGENT（markdown 渲染，流式光标）、REASONING（暗色折叠块）、APPROVAL（卡片：标题/详情/risk 徽章 + Allow once / Always allow / Reject 按钮）、ERROR（红条）、NOTICE（灰条）
- 流式 item：`streaming=true` 时尾部闪烁光标；自动滚动到底部（用户上滚时暂停）
- markdown 渲染：轻量自写（段落/代码块/行内代码/粗体/列表），不引大依赖

- [ ] **Step 3: ApprovalBanner** — pendingApprovals 非空时置顶横幅 + ApprovalRenderer 内联卡片双入口；决策 → `hostRequest("approval/respond")`；决策后 approval.resolved 事件更新 item。
- [ ] **Step 4: Commit** — `feat(renderer): agent timeline with item renderer registry and approvals`

### Task 5.7: Composer

**Files:**
- Create: `src/renderer/features/composer/Composer.tsx`

- [ ] **Step 1: 行为** — textarea（Enter 发送 / Shift+Enter 换行）；按 EffectiveCapabilities（`host/capabilities` 缓存）显隐：RUNNING → 显示 Interrupt（`run/interrupt`）与 Steer（有 steer 能力时，`run/steer` 发送文本不结束当前 run）；发送 → `run/start`（乐观插入 user_message item：本地直接 push，避免等事件回显）；disabled 条件：无选中 thread / run 进行中且无 steer。
- [ ] **Step 2: Commit** — `feat(renderer): composer with capability-driven controls`

### Task 5.8: Surfaces — Files / Diff / Terminal / Artifact + 管理器

**Files:**
- Create: `src/renderer/surfaces/SurfacePane.tsx`, `SurfaceTabs.tsx`
- Create: `src/renderer/surfaces/files/FilesSurface.tsx`, `diff/DiffSurface.tsx`, `terminal/TerminalSurface.tsx`, `artifacts/ArtifactSurface.tsx`

- [ ] **Step 1: SurfacePane** — 右栏容器：tabs（多 surface 并存，点击切换）、Pin（锁定不被新 surface 替换）、Close；宽度拖拽（左边缘 resize handle，存 ui store）。

- [ ] **Step 2: FilesSurface** — 目录树（懒加载 `fs/list`，展开/刷新），文件点击 → `fs/read` 显示内容（只读 Monaco 或 pre），编辑模式 textarea + Save → `fs/write`；"Open in Editor/Reveal" 经 appRequest。

- [ ] **Step 3: DiffSurface** — props：`{ path, patch? }`；有 patch → 逐行渲染 +/-（红绿行，hunk 头）；无 patch → `fs/read` + git diff 不可用时显示当前内容 + "file changed by agent" 说明。MVP 用 Monaco DiffEditor（original=空/修改前缓存，modified=当前），未缓存修改前时降级为 patch/纯文本视图。

- [ ] **Step 4: TerminalSurface** — xterm.js（`@xterm/xterm` + fit addon）；打开时 `terminal/create { workspaceId }` → 订阅 `terminalOutput`（按 terminalId 路由）写 term；`term.onData → terminal/write`；resize → `terminal/resize`；关闭 tab → `terminal/dispose`。

- [ ] **Step 5: ArtifactSurface** — `artifact/list(threadId)` 列表 + 点击 `artifact/read` 预览（markdown/text 直接渲染，image 用 file:// img，二进制显示 "Export to view"）；Export → dialog 保存路径 → `artifact/export`。
- [ ] **Step 6: Commit** — `feat(renderer): files, diff, terminal, artifact surfaces`

### Task 5.9: 设置页

**Files:**
- Create: `src/renderer/features/settings/SettingsPage.tsx`

- [ ] **Step 1: 行为** — 模态/页面：DeepSeek（API Key password input + 显示/隐藏 + "Save"（appRequest settings/set；保存后 Main 自动 `settings/setRuntimeSecret` 重连）、model select（chat/reasoner）、baseUrl）；Codex（command 路径、model）；Approval 默认策略 select；连接测试按钮（`host/listRuntimes` + ping）。
- [ ] **Step 2: Commit** — `feat(renderer): settings page with deepseek key management`

### Task 5.10: Runtime Inspector（轻量）

**Files:**
- Create: `src/renderer/features/inspector/InspectorSurface.tsx`

- [ ] **Step 1: 行为** — surface 的一种：显示每个 runtime/backend：连接状态（hostStatus + adapter 状态）、能力矩阵（EffectiveCapabilities 打勾表）、事件计数（timeline store 统计）、版本信息（getInfo）。
- [ ] **Step 2: Commit** — `feat(renderer): runtime inspector surface`

---

## Stage 6 — 集成验证

### Task 6.1: Host 级双 runtime 冒烟

- [ ] **Step 1: 写 `packages/agent-runtime-host/scripts/smoke.mjs`**：起 host → deepseek（fake SSE server 提供 "say hi" 响应）完整 turn 断言事件序列；`smoke-codex.mjs`（skipIf 无 codex）：真实 codex app-server thread/start + turn/start "reply with OK only"，断言收到 run.completed。Run: `node packages/agent-runtime-host/scripts/smoke.mjs` → PASS
- [ ] **Step 2: Commit** — `test(host): dual-runtime smoke scripts`

### Task 6.2: E2E 冒烟（Playwright Electron）

**Files:**
- Create: `apps/desktop/e2e/smoke.spec.ts`, `playwright.config.ts`（webServer 起 forge dev 或 build 后 electron）

- [ ] **Step 1: 用例**（fake deepseek server，跳过真实 codex turn）：
  1. 启动 app → 创建 workspace（注入测试目录）
  2. 新建 deepseek thread → 发送消息 → timeline 出现 user_message + agent_message（fake SSE 固定回复）
  3. 危险命令审批卡片出现 → Reject → timeline 更新
- [ ] **Step 2: 运行 `pnpm --filter aether-desktop exec playwright test` → PASS；Commit** — `test(e2e): electron smoke`

### Task 6.3: 收尾验证 + 文档

- [ ] **Step 1: 全量验证**：`pnpm -r build && pnpm -r test && pnpm typecheck` 全绿
- [ ] **Step 2: 真实联通验证（手动）**：`pnpm dev` → 设置页配置 DeepSeek API Key → deepseek thread 发"读取 README.md 并总结" → 观察 read_file 工具调用 + 回答；codex thread 发"运行 ls 并告诉我结果" → 命令审批 → CommandItem；重启 app → thread 恢复
- [ ] **Step 3: 更新 README（构建/运行/测试说明）+ Commit** — `docs: usage instructions`

---

## Self-Review 记录

- Spec 覆盖：§1 进程架构→Stage 4/5；§2 结构→Task 0.1/5.1；§3 领域→1.1；§4 host 协议→1.2/4.1；§5 事件→1.2/2.1；§6 codex→3.3；§7 deepseek→3.1/3.2；§8 renderer→5.4-5.10；§9 main/存储→5.2/5.3；§10 错误处理→2.1/4.1/5.3；§11 测试→各任务+6.x；§12 验收→6.3。无缺口。
- 占位符扫描：无 TBD/TODO；UI 任务以行为规格+关键代码表达（执行者为同一会话，具完整上下文）。
- 类型一致性：`ApprovalDecisionValue`（4 值）、`approvalMode`（3 值）、`RuntimeEvent.sequence` per-thread 单调、host 方法名在 1.2/4.1/5.1 三处一致（HOST_METHODS 单一来源）。
