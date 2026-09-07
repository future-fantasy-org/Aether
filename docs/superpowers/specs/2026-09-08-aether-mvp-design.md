# Aether MVP 实现设计（Spec）

> 日期：2026-09-08
> 依据：`arch.md`（Aether Architecture）+ 用户澄清
> 状态：已确认

## 0. 范围与决策记录

| 决策点 | 结论 |
|---|---|
| 功能范围 | MVP（arch.md §40）+ Artifact 基础展示 |
| DeepSeek 接入 | monorepo 内置参考 Harness（独立 Node CLI 进程，真实调用 DeepSeek API） |
| Codex 接入 | `codex app-server`（本机 codex-cli 0.144.1，JSON-RPC 2.0 over stdio） |
| DeepSeek API Key | 仅设置界面配置，存 SQLite；不读环境变量；不落 host 进程磁盘 |
| 进程架构 | 方案 A：Sidecar（Electron Main spawn Agent Execution Host 独立 Node 进程） |

MVP 交付：

```
Workspace / Thread / Timeline / Composer / Files / Diff / Terminal
Codex Local（codex app-server）
DeepSeek Local（内置参考 harness）
Artifact（领域模型 + Timeline 呈现 + 打开/导出）
Approval（统一审批 UI，双 runtime）
```

不做（Phase 2+）：Browser、MCP、Sub-Agent、Cloud Backend、Runtime Handoff、SSO 等企业能力。

## 1. 进程架构

```
Electron Renderer ──contextBridge IPC──▶ Electron Main ──spawn + stdio JSON-RPC──▶ Agent Execution Host（独立 Node 进程）
                                                                                    ├─ CodexAdapter ──stdio──▶ codex app-server
                                                                                    ├─ DeepSeekAdapter ──stdio──▶ deepseek-harness
                                                                                    ├─ LocalFileProvider / LocalPtyProvider
                                                                                    └─ Event Normalizer / Approval Router
```

- Electron Main 只做：窗口、IPC 桥、SQLite（平台元数据）、Sidecar 生命周期。
- Agent Execution Host 持有全部 Agent 业务逻辑；崩溃由 Main 检测并重启，重启后 renderer 重新订阅并 replay。
- 双桥协议均为 JSON-RPC 2.0（renderer↔main 为类型化 IPC 包装；main↔host 与 host↔runtime 为 stdio JSONL）。

## 2. Monorepo 结构

```
aether/
├── apps/desktop/                 # Electron 应用（main / preload / renderer）
├── packages/
│   ├── agent-contracts/          # RuntimeEvent、AgentItem、ApprovalRequest/Decision、HostApi 协议（Zod）
│   ├── agent-domain/             # Workspace/Thread/Run/Item/Artifact/Capability 领域模型
│   ├── agent-runtime-host/       # Agent Execution Host（sidecar 进程入口 + 模块）
│   ├── agent-runtime-client/     # Renderer 侧客户端（IPC → host 命令/事件流）
│   ├── agent-projection/         # 事件 → View Model 纯函数投影
│   ├── workspace-provider/       # WorkspaceFileProvider 接口 + LocalFileProvider
│   ├── terminal-provider/        # TerminalSession 接口 + node-pty 本地实现
│   ├── artifact-provider/        # Artifact 接口 + LocalArtifactProvider
│   ├── runtime-codex/            # CodexAdapter + StdioTransport + 协议类型快照
│   ├── runtime-deepseek/         # DeepSeekAdapter + harness/（参考实现，独立可执行）
│   └── desktop-contracts/        # Renderer↔Main IPC 契约类型
├── pnpm-workspace.yaml
└── docs/
```

工具链：pnpm workspace、TypeScript project references、Vite（renderer）、Electron Forge（打包）、Vitest（测试）。

## 3. 领域模型（agent-domain）

- `Workspace { id, name, binding: LocalWorkspace|RemoteWorkspace|RepositoryWorkspace|ManagedWorkspace, settings }`
- `Thread { id(Aether ID), workspaceId, title, createdAt, updatedAt, archived, runtimeBinding? }`
- `RuntimeBinding { runtimeId, backendId, externalThreadId?, runtimeVersion?, protocolVersion? }`
- `Run { id, threadId, status: QUEUED|STARTING|RUNNING|WAITING_TOOL|WAITING_APPROVAL|COMPLETED|FAILED|CANCELLED|INTERRUPTED|DISCONNECTED, startedAt, endedAt, error? }`
- `AgentItem` 联合（14 种）：UserMessage / AgentMessage / ReasoningSummary / Plan / ToolCall / Command / FileChange / Browser / Search / Approval / Artifact / SubAgent / Error / Notice
- `Artifact { id, type, location: Local|Remote, metadata }`
- Capability：`RuntimeCapabilities ∩ BackendCapabilities = EffectiveCapabilities`；UI 禁止 `runtime === "codex"` 判断

## 4. Host 协议（agent-contracts）

JSON-RPC 2.0 over stdio（JSONL）。请求：

```
host/ping, host/shutdown
host/listRuntimes, host/listBackends, host/capabilities(runtimeId, backendId)
workspace/list, workspace/create, workspace/open(reveal)
thread/list, thread/create, thread/rename, thread/archive, thread/read, thread/select(runtime 切换)
run/start, run/interrupt, run/steer
approval/respond
fs/list, fs/read, fs/write, fs/stat
terminal/create, terminal/write, terminal/resize, terminal/dispose
artifact/list, artifact/read, artifact/export
settings/setRuntimeSecret (Main → Host 单向下发)
```

通知（Host → Main → Renderer）：

```
runtimeEvent       # 归一化 RuntimeEvent：eventId/sequence/timestamp/runtimeId/backendId/threadId/runId/type/payload
approvalRequested  # 统一 ApprovalRequest
runStateUpdated
hostStatus         # 启动/运行中/重启
```

审批：runtime 反向请求 → Adapter 转 `ApprovalRequest` → Host → Renderer 展示统一 UI → `approval/respond` → 原路返回 runtime。

## 5. RuntimeEvent（agent-contracts）

```ts
interface RuntimeEvent {
  eventId: string; sequence: number; timestamp: string;
  runtimeId: string; backendId: string; threadId: string; runId?: string;
  type: RuntimeEventType; payload: unknown; raw?: unknown;
}
```

type 集（MVP）：`thread.started / run.started / run.completed / run.failed / run.cancelled / message.delta / message.completed / reasoning.delta / reasoning.completed / plan.updated / tool.started / tool.completed / command.started / command.output / command.completed / filechange.detected / filechange.patch / approval.requested / approval.resolved / error / notice`

事件全链路单向：Runtime → Adapter(normalize+序号) → Host → Main → Renderer → Projection → Timeline。重连恢复：记录 last sequence，`thread/read` 快照 + 增量事件。

## 6. CodexAdapter（runtime-codex）

协议类型快照：`codex app-server generate-ts` 生成物拷贝入 `runtime-codex/src/protocol/`（升级时重新生成）。

映射（已对照 codex-cli 0.144.1 实测生成物）：

| Codex | Aether |
|---|---|
| `thread/start`(cwd/model/approvalPolicy/sandbox) | `thread/create` + RuntimeBinding |
| `thread/list` `thread/read` `thread/resume` | listThreads / readThread（Timeline 恢复） |
| `turn/start`(input) | `run/start` |
| `turn/interrupt` / `turn/steer` | run.interrupt / steer |
| userMessage/agentMessage item + AgentMessageDelta | UserMessageItem / AgentMessageItem（流式合并） |
| reasoning item + ReasoningSummaryTextDelta | ReasoningSummaryItem |
| plan item + TurnPlanUpdated(TurnPlanStep) | PlanItem |
| commandExecution item + CommandExecutionOutputDelta | CommandItem |
| fileChange item + FileChangePatchUpdated / TurnDiffUpdated | FileChangeItem（含 patch/统计） |
| ErrorNotification | ErrorItem / run.failed |
| Server→Client：CommandExecution/FileChange/Permissions RequestApproval | 统一 ApprovalRequest ↔ ApprovalDecision |
| ItemStarted/ItemCompleted/ThreadStatusChanged | run/item 生命周期与状态投影 |

Transport：`StdioTransport`（spawn `codex app-server`）；`HttpTransport` 仅留接口不实现。

Approval 回调使用 JSON-RPC server→client request，Adapter 挂起等待 Aether decision 后应答。

## 7. DeepSeek Harness（runtime-deepseek/harness）

独立 Node CLI（`bin` 入口，无 Electron 依赖），JSON-RPC 2.0 over stdio，方法名与 Host 对齐（thread/start、turn/start、turn/interrupt、thread/read、thread/list…）。

- Agent Loop：OpenAI 兼容流式 `POST https://api.deepseek.com/chat/completions`，`stream:true`；模型 `deepseek-chat` / `deepseek-reasoner`；`reasoning_content` → reasoning 事件
- 工具（function calling）：`read_file / write_file / edit_file / glob / grep / run_shell`
- 系统 prompt：coding agent 角色约束
- 审批：run_shell 命中策略（可配置：rm -rf、sudo、curl|sh 等默认危险模式 + 写路径越界）→ 反向 `approval/request` → 阻塞至 decision；reject 则返回工具错误并告知模型
- 会话：`~/.aether/runtimes/deepseek/sessions/<sessionId>.jsonl` 追加写（含全部事件，sequence 单调）；`thread/read` 全量重放
- API Key：host 启动时经 stdin `initialize` 参数传入（内存持有；不进 argv / 不落盘）
- 无 Key / 网络错误：返回结构化错误事件（ErrorItem + run.failed），UI 明确提示

DeepSeekAdapter：与 CodexAdapter 同接口；harness 事件已同构 RuntimeEvent，Adapter 主要做透传 + 校验 + 审批路由。

## 8. Renderer（apps/desktop/src/renderer）

三栏布局：左（Workspace/Threads/Runtime 状态）｜中（Timeline + Composer）｜右（Surface：Diff/Files/Terminal/Artifact，Pin/Close，可折叠）。

- Timeline：树状工作流视图（§18），ItemRenderer Registry 分发；流式 item 实时更新；虚拟滚动
- Composer：发送、Steer（RUNNING 时）、Interrupt（按 EffectiveCapabilities 显隐）、runtime/模型选择
- Projection（agent-projection 纯函数）：流式 message 合并、command 状态机、plan 步骤状态、file diff 聚合、run 状态恢复
- Zustand：UI state（布局、选中、surface 栈）；TanStack Query：workspace/thread 列表
- Monaco DiffEditor（diff surface）、xterm.js（terminal surface，经 host PTY）
- Files Surface：经 WorkspaceFileProvider 的树 + 编辑（写回 LocalFileProvider）
- Artifact：Timeline 中 ArtifactItem + 右侧预览/打开/导出
- 设置页：Runtime 配置（codex 可执行路径、模型；deepseek 模型、API Key）、Approval 策略、外观
- Runtime Inspector（轻量）：显示 runtime/backend 连接状态、能力矩阵、事件计数

## 9. Electron Main / preload / 存储

Main 模块：window / ipc（双向桥 + 类型校验）/ persistence（SQLite）/ sidecar（spawn、stdout↔stdin 桥、health ping、崩溃重启指数退避、退出清理）/ native（打开文件、reveal in Finder、通知）。

preload：contextBridge 暴露 `window.aether`：`invoke(channel, payload)` + `onEvent(channel, cb)`，全部走 desktop-contracts 类型。

SQLite（Main 持有，`node:sqlite`，失败回退 better-sqlite3）：workspaces、threads（Aether↔external 映射）、settings（含 deepseekApiKey，OS keychain 可后续增强）、ui_state、projection_cache。

## 10. 错误处理

- Host 崩溃：Main 重启 → `hostStatus(restarted)` → renderer 重新订阅 + `thread/read` replay
- Runtime 进程退出：Adapter 标记 DISCONNECTED → Run 落 INTERRUPTED/DISCONNECTED + ErrorItem
- 审批超时：默认不超时，UI 可 Reject；runtime 侧按 reject 处理
- 事件乱序：Projection 按 sequence 排序缓冲

## 11. 测试策略

- agent-projection：事件序列 → Timeline 快照（流式合并、重放、乱序）
- runtime-deepseek harness：fake DeepSeek SSE 服务器驱动完整 turn（含工具调用与审批往返）
- runtime-codex：协议映射单测（录制 fixture）+ 真实 `codex app-server` 冒烟
- host：内存 transport 驱动的集成测试（registry/binding/approval 回路）
- E2E：Playwright + Electron：「创建 Workspace → 新建 Thread → 发消息 → Timeline 出项 → 审批 → 完成」双 runtime 各跑一遍

## 12. 验收标准

1. `pnpm dev` 启动 Aether 桌面应用
2. Codex Local：选 codex runtime 创建 Thread，发消息产生完整 Timeline（消息/推理/命令/文件变更），审批往返正常，`thread/read` 重启后恢复
3. DeepSeek Local：设置页配置 API Key 后，deepseek runtime 可跑通工具调用 turn（读文件→修改→shell 测试），审批往返正常，会话 JSONL 可重放
4. Files/Diff/Terminal/Artifact Surface 全部可用
5. 全部单测/集成测试通过；E2E 双 runtime 通过
