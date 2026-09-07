# Aether Architecture

> **One workspace. Every agent.**
> 一个工作台，连接所有 Agent。

**Aether** 是 FutureFantasy Tech 面向 AI Agent 的通用桌面工作台。

Aether 本身不重新实现 Codex、DeepSeek Harness 等 Agent Runtime，而是提供统一的 **Agent 展示层、交互层、Workspace 层和运行时接入层**。

它希望让不同 Agent，无论运行在本地、远程服务器还是 Cloud 环境，都能以统一方式展示和工作。

---

# 1. 产品定位

Aether 的核心定位不是：

* 一个聊天客户端
* 一个 Codex GUI
* 一个 DeepSeek GUI
* 一个新的 Agent Runtime

而是：

> **Runtime-Agnostic Agent Workbench**

即：

> 面向不同 Agent Runtime 的统一桌面工作台。

未来可以接入：

```text
Codex Local
Codex Cloud

DeepSeek Harness Local
DeepSeek Harness Cloud

Claude / OpenCode / Custom Agent

Enterprise Agent
Remote Agent
Private Cloud Agent
```

用户不需要理解底层 Runtime 的具体协议，只需要面对统一的：

```text
Workspace
Thread
Run
Timeline
Files
Diff
Terminal
Browser
Artifacts
Approvals
```

---

# 2. 核心设计目标

Aether 有五个核心目标。

## 2.1 Runtime 无关

React UI 不应该知道底层是：

```text
Codex
DeepSeek
Claude
Custom Agent
```

UI 只消费统一的 Agent Domain Model。

例如：

```text
Thread
Run
Item
Artifact
Action
```

不同 Runtime 的差异由 Adapter 消化。

---

## 2.2 Local / Cloud 无关

Agent 可以运行在：

```text
Local Process
Docker
Remote Server
Cloud Agent
Enterprise Private Cloud
```

对于 UI 来说应该基本一致。

因此：

> Runtime 和 Execution Location 必须分离。

---

## 2.3 Renderer 不拥有 Agent 真相

React Renderer 只负责：

```text
展示
交互
UI State
Projection
```

不能自己创建或推测：

```text
Agent Run State
Tool Execution State
Runtime Session State
```

Agent Runtime 才是 Agent 执行状态的权威来源。

---

## 2.4 Desktop Host 保持轻量

Electron Main 只负责桌面宿主能力：

```text
Window
IPC
Tray
Updater
Native API
File Picker
Notification
Sidecar Lifecycle
OS Permission
```

不能变成：

> 第二套 Agent Backend。

---

## 2.5 Capability Driven UI

不能假设所有 Agent 都支持：

```text
Plan
Shell
Browser
MCP
Fork
Steer
Sub-Agent
Approval
```

UI 必须根据 Runtime / Backend 能力动态变化。

---

# 3. 总体架构

整体架构如下：

```text
                          User
                           │
                           ▼
┌────────────────────────────────────────────────────┐
│                   Aether Desktop                   │
│                                                    │
│ Workspace │ Threads │ Timeline │ Composer          │
│                                                    │
│ Files │ Diff │ Terminal │ Browser │ Artifacts     │
└─────────────────────────┬──────────────────────────┘
                          │
                    UI Contracts
                          │
                          ▼
┌────────────────────────────────────────────────────┐
│                Presentation Layer                  │
│                                                    │
│ React Renderer                                     │
│ UI State                                           │
│ Projection                                         │
│ Surface Manager                                    │
│ Item Renderer Registry                             │
└─────────────────────────┬──────────────────────────┘
                          │
                       IPC
                          │
                          ▼
┌────────────────────────────────────────────────────┐
│                Electron Desktop Host               │
│                                                    │
│ Window │ IPC │ Native │ Updater │ Sidecar Host    │
└─────────────────────────┬──────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────┐
│                Agent Execution Host                │
│                                                    │
│ Runtime Registry                                   │
│ Backend Registry                                   │
│ Capability Resolver                                │
│ Session Binding                                    │
│ Connection Manager                                 │
│ Event Normalizer                                   │
│ Approval Router                                    │
│ Workspace Provider                                 │
│ Artifact Provider                                  │
└──────────────┬────────────────────┬────────────────┘
               │                    │
               ▼                    ▼
       ┌──────────────┐      ┌────────────────┐
       │ Codex Adapter│      │DeepSeek Adapter│
       └───────┬──────┘      └────────┬───────┘
               │                      │
        ┌──────┴──────┐        ┌──────┴──────┐
        │             │        │             │
      Local         Cloud    Local         Cloud
        │             │        │             │
    App Server       API     Harness         API
```

---

# 4. 架构分层

Aether 可以划分为六层。

```text
Experience Layer
        ↓
Presentation Layer
        ↓
Desktop Host
        ↓
Agent Execution Host
        ↓
Runtime Adapter
        ↓
Runtime / Cloud Backend
```

---

# 5. Experience Layer

这是用户真正看到的产品。

主要包含：

```text
Workspace

Thread List

Agent Timeline

Composer

Files

Diff

Terminal

Browser

Artifact

Approval

Runtime Inspector
```

第一阶段桌面端采用：

```text
Electron
React
TypeScript
Vite
```

---

# 6. Presentation Layer

Presentation Layer 是 Aether 的核心前端架构。

它负责：

```text
UI State
View Model
Runtime Event Projection
Timeline Rendering
Surface Management
User Interaction
```

但不负责：

```text
Agent Loop
Planning
Tool Execution
Shell Execution
Session Persistence
```

---

# 7. Agent Execution Host

这是 Aether 最关键的中间层。

它不是 Agent Runtime。

它的职责是：

> 将不同 Runtime 转换为统一的 Aether Agent Model。

可以理解成：

```text
                       UI
                        │
                        ▼
                Agent Execution Host

         Runtime differences stop here

       ┌─────────┼─────────┐
       ↓         ↓         ↓
     Codex    DeepSeek   Future Runtime
```

主要模块包括：

```text
Runtime Registry
Backend Registry
Connection Manager
Capability Resolver
Runtime Adapter
Event Normalizer
Session Binding
Approval Router
Workspace Provider
Terminal Provider
Artifact Provider
```

---

# 8. 三个必须区分的核心概念

这是整个架构最重要的一部分。

必须区分：

```text
Runtime
Backend
Transport
```

---

## 8.1 Runtime

Runtime 表示：

> Agent 是怎么工作的。

例如：

```text
Codex

DeepSeek Harness

Custom Runtime
```

Runtime 定义：

```text
Thread / Session

Run

Tool

Agent Loop

Approval

Planning
```

等 Agent 语义。

---

# 9. Execution Backend

Backend 表示：

> Agent 在哪里运行。

例如：

```text
Local

Cloud

Remote Server

Enterprise

Private Cloud
```

因此：

```text
Runtime = Codex
Backend = Local
```

和：

```text
Runtime = Codex
Backend = Codex Cloud
```

是两个不同配置。

---

# 10. Transport

Transport 只解决：

> Aether 怎么与 Backend 通信。

例如：

```text
stdio

JSON-RPC

HTTP

SSE

WebSocket
```

最终：

```text
CodexRuntimeAdapter
        │
        ├─ LocalTransport
        │       ↓
        │    stdio
        │
        └─ CloudTransport
                ↓
           HTTPS / SSE
```

因此不要设计：

```text
CodexLocalAdapter
CodexCloudAdapter
```

更推荐：

```text
CodexAdapter
    +
ExecutionBackend
    +
Transport
```

---

# 11. 核心领域模型

Aether 自己应该维护一套独立领域模型。

核心模型：

```text
Workspace
Thread
Run
Item
Artifact

Runtime
ExecutionBackend
RuntimeBinding

Capability
Event
```

关系：

```text
Workspace
    │
    ├── Thread
    │     │
    │     ├── Run
    │     │     │
    │     │     ├── Item
    │     │     └── Artifact
    │     │
    │     └── RuntimeBinding
    │
    └── Resources
```

---

# 12. Workspace

Workspace 是用户工作的逻辑空间。

不要等价于：

```text
本地文件夹
```

因为未来 Cloud Agent 的 Workspace 可能完全在远端。

建议：

```ts
interface Workspace {

  id: string;

  name: string;

  binding: WorkspaceBinding;

  settings: WorkspaceSettings;

}
```

WorkspaceBinding：

```text
LocalWorkspace

RemoteWorkspace

RepositoryWorkspace

ManagedWorkspace
```

---

## Local Workspace

例如：

```text
/Users/alice/project
```

---

## Remote Workspace

例如：

```text
Codex Cloud Workspace

workspaceId:
ws_xxx
```

---

## Repository Workspace

例如：

```text
github.com/futurefantasy/aether

branch:
feature/runtime-adapter
```

---

# 13. Thread

Thread 是一个持续的 Agent 工作上下文。

例如：

```text
"重构 OrderService"
```

Thread 可以持续：

```text
几分钟
几小时
几天
几个月
```

Aether 应该拥有自己的：

```text
Aether Thread ID
```

然后映射到底层 Runtime。

例如：

```text
Aether Thread
      │
      ├── Codex Thread ID
      │
      └── DeepSeek Session ID
```

不要直接使用 Runtime Thread ID 作为 Aether ID。

---

# 14. RuntimeBinding

```ts
interface RuntimeBinding {

  runtimeId: string;

  backendId: string;

  externalThreadId?: string;

  runtimeVersion?: string;

  protocolVersion?: string;

}
```

例如：

```text
Aether Thread

runtime:
codex

backend:
codex-local

externalThread:
019xxxx
```

未来也可能：

```text
runtime:
deepseek

backend:
deepseek-cloud

externalThread:
session_xxx
```

---

# 15. Run

Run 表示：

> 一次 Agent 执行。

例如用户发送：

```text
帮我把测试补齐
```

产生：

```text
Run #42
```

生命周期：

```text
QUEUED
   ↓
STARTING
   ↓
RUNNING
   ↓
WAITING_TOOL
   ↓
RUNNING
   ↓
WAITING_APPROVAL
   ↓
RUNNING
   ↓
COMPLETED
```

还应该支持：

```text
FAILED

CANCELLED

INTERRUPTED

DISCONNECTED
```

---

# 16. Detached Run

为了支持 Cloud Agent，Run 必须独立于 Electron 生命周期。

允许：

```text
Aether
   ↓
Start Run
   ↓
Cloud Agent Running
   ↓
用户关闭 Aether
   ↓

两小时以后

打开 Aether
   ↓
Reconnect
   ↓
Replay Events
   ↓
恢复 Timeline
```

所以：

> UI 不是 Run 生命周期的 Owner。

---

# 17. Item

Item 是 Agent Timeline 的最基本单位。

推荐：

```ts
type AgentItem =

  | UserMessageItem
  | AgentMessageItem

  | ReasoningSummaryItem
  | PlanItem

  | ToolCallItem
  | CommandItem
  | FileChangeItem

  | BrowserItem
  | SearchItem

  | ApprovalItem

  | ArtifactItem

  | SubAgentItem

  | ErrorItem
  | NoticeItem;
```

无论 Codex 还是 DeepSeek，最终都转成 Item。

---

# 18. Timeline

Timeline 是整个 Aether UI 最核心的区域。

不要设计成传统聊天气泡：

```text
User

Assistant

User

Assistant
```

而应该表现 Agent 的整个工作过程：

```text
USER
│
│  修复这个 Bug
│
├─ PLAN
│
│  ✓ Inspect code
│  ✓ Locate issue
│  ○ Modify implementation
│  ○ Run tests
│
├─ READ
│
│  src/OrderService.ts
│
├─ SEARCH
│
│  createOrder(...)
│
├─ EDIT
│
│  OrderService.ts
│
│  +32
│  -12
│
├─ COMMAND
│
│  npm test
│
│  ✓ 138 passed
│
└─ AGENT

   Bug fixed.
```

---

# 19. Item Renderer

不同 Item 应该由独立 Renderer 渲染。

```text
AgentItem
     │
     ▼
Item Renderer Registry
     │
     ├─ MessageRenderer
     ├─ PlanRenderer
     ├─ CommandRenderer
     ├─ FileChangeRenderer
     ├─ ApprovalRenderer
     └─ ArtifactRenderer
```

接口可以类似：

```ts
interface ItemRenderer<T extends AgentItem> {

  type: T["type"];

  render(item: T): ReactNode;

}
```

这样新增 Runtime 不需要修改整个 Timeline。

---

# 20. Surface

除了 Timeline，Agent 经常需要展示复杂工作内容。

因此引入：

> Surface

例如：

```text
File Surface

Diff Surface

Terminal Surface

Browser Surface

Artifact Surface

Evidence Surface
```

右侧区域可以：

```text
Pin

Split

Close

Fullscreen

Pop Out
```

最终 UI：

```text
┌────────────┬────────────────────────┬───────────────┐
│            │                        │               │
│ Workspace  │     Agent Timeline     │    Surface    │
│            │                        │               │
│ Threads    │                        │    Diff       │
│            │                        │               │
│ Agents     │                        │    Files      │
│            │                        │               │
│ Tasks      │                        │    Terminal   │
│            │                        │               │
└────────────┴────────────────────────┴───────────────┘
```

---

# 21. RuntimeAdapter

RuntimeAdapter 解决：

> 不同 Agent Runtime 的语义差异。

例如：

```ts
interface AgentRuntimeAdapter {

  readonly runtimeId: string;

  getInfo(): Promise<RuntimeInfo>;

  getCapabilities():
    Promise<RuntimeCapabilities>;

  listThreads():
    Promise<AgentThread[]>;

  createThread(
    request: CreateThreadRequest
  ): Promise<AgentThread>;

  readThread(
    threadId: string
  ): Promise<ThreadSnapshot>;

  startRun(
    request: StartRunRequest
  ): Promise<AgentRun>;

  interruptRun(
    runId: string
  ): Promise<void>;

  respondApproval(
    request: ApprovalResponse
  ): Promise<void>;

  subscribe(
    listener:
      (event: RuntimeEvent) => void
  ): Disposable;

}
```

---

# 22. Codex Adapter

例如：

```text
Codex

Thread
     ↓
Aether Thread

Turn
     ↓
Aether Run

CommandExecution
     ↓
CommandItem

FileChange
     ↓
FileChangeItem

ToolCall
     ↓
ToolCallItem
```

Codex 协议怎么变化：

> 只修改 Codex Adapter。

React UI 不应该感知。

---

# 23. DeepSeek Adapter

类似：

```text
DeepSeek Session
       ↓
Aether Thread

Agent Turn
       ↓
Aether Run

Session Event
       ↓
Runtime Event
       ↓
Agent Item
```

DeepSeek Harness 内部插件体系如何变化，同样由 Adapter 吸收。

---

# 24. Runtime Event

Aether 最好采用事件驱动方式处理 Runtime 输出。

```ts
interface RuntimeEvent {

  eventId: string;

  sequence?: number;

  timestamp: string;

  runtimeId: string;

  backendId: string;

  threadId: string;

  runId?: string;

  type: RuntimeEventType;

  payload: unknown;

  raw?: unknown;

}
```

数据流：

```text
Runtime

   ↓

Raw Event

   ↓

Runtime Adapter

   ↓

Normalized Event

   ↓

Projection

   ↓

AgentItem

   ↓

Timeline
```

---

# 25. Event Replay

为了支持 Cloud Agent：

```text
Event
```

必须尽可能具备：

```text
eventId

sequence

timestamp
```

例如：

```text
收到 Event #182
```

然后网络断开。

重新连接：

```text
GET events after #182
```

最终恢复：

```text
183
184
185
...
```

Timeline 不丢失。

---

# 26. Projection

UI 不应该直接消费 Runtime 原始 Event。

应该经过：

```text
Raw Event
   ↓
Normalized Event
   ↓
Projection
   ↓
View Model
   ↓
UI
```

Projection 负责：

```text
合并 streaming message

更新 command 状态

更新 plan 状态

聚合 file diff

恢复 run state

构建 timeline
```

---

# 27. Capability System

不同 Agent 能力不同。

因此必须有：

```text
RuntimeCapabilities
```

和：

```text
BackendCapabilities
```

---

## Runtime Capability

回答：

> Agent 本身会什么？

例如：

```text
Plan

Shell

Files

MCP

Sub-Agent

Approval

Steer

Fork
```

---

## Backend Capability

回答：

> 当前执行环境允许什么？

例如：

```text
Background Run

Persistent Workspace

Remote Terminal

Browser

File Sync

Artifact Download
```

最终：

```text
Effective Capability

=

Runtime Capability

∩

Backend Capability
```

UI 根据 Effective Capability 展示功能。

---

# 28. Files Provider

不要让 Renderer 直接访问 Node：

```ts
fs.readFile()
```

统一：

```ts
interface WorkspaceFileProvider {

  list(path: string):
    Promise<FileEntry[]>;

  read(path: string):
    Promise<FileContent>;

  write?(
    path: string,
    content: string
  ): Promise<void>;

  stat(path: string):
    Promise<FileStat>;

}
```

实现可以是：

```text
LocalFileProvider

CodexCloudFileProvider

DeepSeekCloudFileProvider
```

因此 Files Surface 不关心文件在哪。

---

# 29. Terminal Provider

Terminal UI 可以统一用：

```text
xterm.js
```

但背后不能绑定：

```text
child_process
```

而应该：

```text
Terminal Surface
       ↓
TerminalSession
       ↓
┌──────────────┬──────────────────┐
│              │                  │
Local PTY   Codex Cloud      DeepSeek Remote
```

---

# 30. Artifact Provider

Artifact 是 Agent 的工作成果。

例如：

```text
Markdown

Code

PDF

Excel

Image

Report
```

Artifact 可能：

```text
Local
```

也可能：

```text
Remote
```

所以：

```ts
interface Artifact {

  id: string;

  type: ArtifactType;

  location:
    | LocalArtifactLocation
    | RemoteArtifactLocation;

  metadata: ArtifactMetadata;

}
```

UI 统一提供：

```text
Preview

Open

Sync

Export
```

---

# 31. Approval

审批不应该属于某一个 Runtime UI。

统一成：

```text
ApprovalRequest

ApprovalDecision
```

例如：

```text
Agent wants to:

Run

rm -rf build

──────────────────

Allow once

Always allow

Reject
```

底层可以来自：

```text
Codex Approval

DeepSeek Approval

Cloud Agent Approval
```

UI 都显示同一种体验。

---

# 32. Electron Desktop Host

Electron Main 必须严格保持轻量。

应该负责：

```text
Window

Native Menu

Notification

Tray

File Picker

Clipboard

OS Permissions

App Update

Protocol Handler

Sidecar Lifecycle
```

不能负责：

```text
Thread State

Run State

Tool State

Agent Planning

Runtime Business Logic
```

推荐：

```text
Electron Main
      │
      │ spawn
      ▼
Agent Execution Host
      │
      ├─ Codex
      └─ DeepSeek
```

---

# 33. 本地执行流程

Codex Local 示例：

```text
User

 ↓

Composer

 ↓

startRun()

 ↓

Agent Execution Host

 ↓

Codex Adapter

 ↓

Local Transport

 ↓

Codex App Server

 ↓

Codex Runtime

 ↓

Events

 ↓

Codex Adapter

 ↓

Normalized Events

 ↓

Projection

 ↓

Timeline
```

---

# 34. Cloud 执行流程

```text
User

 ↓

startRun()

 ↓

Execution Host

 ↓

Codex Adapter

 ↓

Cloud Transport

 ↓

Codex Cloud Agent

 ↓

Remote Execution

 ↓

SSE / WebSocket

 ↓

Runtime Events

 ↓

Projection

 ↓

Timeline
```

即使 Electron 关闭：

```text
Cloud Run
   ↓
继续执行
```

重新打开：

```text
Reconnect

 ↓

Fetch Run

 ↓

Replay Events

 ↓

恢复 UI
```

---

# 35. Runtime Handoff

未来可以支持：

```text
Codex
   ↓
DeepSeek
```

但不要叫：

> Switch Runtime

因为底层执行状态通常不能直接迁移。

正确概念应该是：

> Handoff

流程：

```text
Codex Thread
     ↓
Generate Context Snapshot
     ↓
Workspace State
     ↓
Relevant Files
     ↓
Task Summary
     ↓
Create DeepSeek Session
     ↓
Continue
```

---

# 36. 本地数据

Aether 可以使用 SQLite 保存平台自身状态：

```text
Workspace

Thread Mapping

Runtime Config

Backend Config

Pinned Threads

Tags

Layout

UI Preferences

Search Index

Projection Cache
```

但不能把：

```text
Runtime Agent State
```

当成自己的 authoritative data。

原则：

> Runtime owns execution truth.

> Aether owns presentation metadata.

---

# 37. 技术栈

第一阶段建议保持简单。

## Desktop

```text
Electron Forge

React

TypeScript

Vite
```

## UI

```text
Tailwind CSS

Radix UI
```

## State

```text
Zustand
```

## Async / Cache

```text
TanStack Query
```

## Contract

```text
TypeScript

Zod
```

## Local Storage

```text
SQLite
```

## Code / Diff

```text
Monaco Editor
```

## Terminal

```text
xterm.js
```

---

# 38. Repository Structure

推荐 monorepo：

```text
aether/
│
├── apps/
│   │
│   └── desktop/
│       │
│       ├── src/
│       │
│       ├── main/
│       │
│       └── preload/
│
├── packages/
│
│   ├── agent-contracts/
│
│   ├── agent-domain/
│
│   ├── agent-runtime-client/
│
│   ├── agent-runtime-host/
│
│   ├── agent-projection/
│
│   ├── agent-ui/
│
│   ├── workspace-provider/
│
│   ├── terminal-provider/
│
│   ├── artifact-provider/
│
│   ├── runtime-codex/
│
│   ├── runtime-deepseek/
│
│   └── desktop-contracts/
│
└── docs/
    │
    ├── architecture.md
    ├── runtime-adapter.md
    ├── agent-domain.md
    ├── ui-design.md
    └── roadmap.md
```

---

# 39. Desktop 目录

```text
apps/desktop/

src/
├── renderer/
│
│   ├── app/
│
│   ├── features/
│   │
│   ├── workspace/
│   ├── thread/
│   ├── composer/
│   ├── timeline/
│   ├── files/
│   ├── diff/
│   ├── terminal/
│   ├── artifacts/
│   └── runtime/
│
├── surfaces/
│
└── components/


main/
├── window/
├── ipc/
├── native/
├── updater/
└── sidecar/


preload/
└── index.ts
```

---

# 40. MVP

第一阶段不要追求真正意义上的“全能”。

先证明：

> 多 Runtime + 统一 Agent UX

成立。

MVP 做：

```text
Workspace

Thread

Timeline

Composer

Files

Diff

Terminal

Codex Local

DeepSeek Local
```

Timeline 第一阶段支持：

```text
Message

Plan

Reasoning Summary

Tool Call

Command

File Change

Approval

Error
```

---

# 41. Phase 2

增加：

```text
Browser

Artifacts

MCP

Skills

Sub-Agent

Runtime Inspector

Remote Runtime

Background Run
```

同时开始支持：

```text
Codex Cloud

DeepSeek Cloud
```

如果对应 Cloud API 已经开放。

---

# 42. Phase 3

进一步进入真正的 Agent Work Platform：

```text
Parallel Agents

Multi-Agent

Agent Handoff

Remote Workspace

Cloud Workspace

Task Queue

Scheduled Task

Automation

Memory

Knowledge

Enterprise Policy
```

---

# 43. Phase 4

企业能力：

```text
SSO

Organization

RBAC

Policy

Audit

Approval Workflow

Private Runtime

Private Cloud

Managed Agent

Observability
```

---

# 44. 架构原则总结

整个项目最重要的是下面 10 条规则。

### 1

**Aether 不是 Agent Runtime。**

---

### 2

**Aether 不重新实现 Codex / DeepSeek Harness。**

---

### 3

**Renderer 不拥有 Agent Execution Truth。**

---

### 4

**Electron Main 不承载 Agent Business Logic。**

---

### 5

**Runtime 和 Backend 必须分离。**

```text
Codex ≠ Codex Local

Codex ≠ Codex Cloud
```

---

### 6

**Local / Remote 差异必须隐藏在 Provider / Backend 层。**

---

### 7

**UI 只能依赖统一 Agent Domain Model。**

```text
Workspace

Thread

Run

Item

Artifact
```

---

### 8

**所有 Runtime 差异通过 Adapter 隔离。**

---

### 9

**所有 UI 能力通过 Capability Negotiation 决定。**

不要：

```ts
if (runtime === "codex")
```

---

### 10

**Cloud Agent 必须天然支持 Detached Run + Event Replay。**

---

# 45. 最终核心架构

整个系统实际上可以浓缩成：

```text
                       Aether
                         │
              ┌──────────┴──────────┐
              │                     │
         Agent Experience       Workspace
              │                     │
              └──────────┬──────────┘
                         │
                  Agent Domain
                         │
                 Projection Layer
                         │
               Agent Execution Host
                         │
             ┌───────────┴───────────┐
             │                       │
      Runtime Adapter         Runtime Adapter
             │                       │
           Codex                  DeepSeek
             │                       │
       ┌─────┴─────┐           ┌─────┴─────┐
       │           │           │           │
     Local       Cloud       Local       Cloud
```

如果未来再接：

```text
Claude Code

OpenCode

Custom Agent

Enterprise Agent
```

只是继续往下面增加：

```text
Runtime Adapter
```

而上层：

```text
Workspace
Thread
Run
Timeline
Files
Terminal
Artifact
```

都不需要推翻。

---

# 46. 一句话定义架构

可以把这句话直接放在 `architecture.md` 最开头：

> **Aether is a runtime-agnostic desktop workspace that normalizes local and cloud AI agents into a unified model of Workspaces, Threads, Runs, Items, and Artifacts.**

中文：

> **Aether 是一个与 Agent Runtime 解耦的桌面工作台，通过统一的 Workspace、Thread、Run、Item 和 Artifact 模型，将本地与云端 AI Agent 映射为一致的工作体验。**
 