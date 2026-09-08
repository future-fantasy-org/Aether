# Aether

> One Workspace, Every Agent — a runtime-agnostic AI agent desktop workspace.

Aether 是一个 **Runtime 无关的 Agent 桌面工作台**：同一个 Workspace、Thread、Timeline 与 Surface 体系，可以接入任何 Agent Runtime（Codex、DeepSeek Harness、未来的更多运行时），并通过统一的抽象（Adapter / Capabilities / RuntimeEvent）消除它们之间的差异。

完整架构设计见 [`arch.md`](./arch.md)，实现规格见 [`docs/superpowers/specs/2026-09-08-aether-mvp-design.md`](./docs/superpowers/specs/2026-09-08-aether-mvp-design.md)。

## 功能（MVP）

- **Workspace / Thread / Timeline / Composer**：三栏工作台；Timeline 是树状工作流视图（消息/推理/计划/命令/文件变更/审批/错误），不是聊天气泡
- **双 Runtime**：
  - **Codex Local** —— 通过 `codex app-server`（JSON-RPC over stdio）接入本机 Codex CLI
  - **DeepSeek Local** —— 内置参考 Harness（`packages/runtime-deepseek`，独立进程）：Agent Loop + 工具调用（read/write/edit/glob/grep/shell）+ 流式推理 + JSONL 会话持久化，真实调用 DeepSeek API
- **统一审批**：危险命令/文件修改/权限请求统一为 ApprovalRequest → 单一审批 UI（Allow once / Always allow / Reject）
- **Surfaces**：Files（浏览/编辑）、Diff（统一 diff 视图）、Terminal（真实 PTY）、Artifact（列表/预览/导出）、Runtime Inspector（能力矩阵/事件计数）
- **断线恢复**：Host sidecar 崩溃自动重启；Thread 状态经 `thread/read` 快照 + 增量事件恢复

## 架构（Sidecar）

```
Electron Renderer ──contextBridge IPC──▶ Electron Main ──spawn + stdio JSON-RPC──▶ Agent Execution Host（独立 Node 进程）
                                                                                    ├─ CodexAdapter ──stdio──▶ codex app-server
                                                                                    ├─ DeepSeekAdapter ──stdio──▶ deepseek-harness
                                                                                    ├─ LocalFileProvider / LocalPtyProvider / LocalArtifactProvider
                                                                                    └─ EventNormalizer / ApprovalRouter
```

事件单向流：`Runtime → Adapter(normalize) → Host → Main → Renderer → Projection → Timeline`。

## Monorepo 布局

| 包 | 职责 |
|---|---|
| `packages/agent-domain` | Workspace/Thread/Run/Item/Artifact/Capability 领域模型 |
| `packages/agent-contracts` | RuntimeEvent、审批、AgentRuntimeAdapter 接口、Host RPC 协议、JSON-RPC peer |
| `packages/agent-projection` | 事件 → 时间线视图模型（纯函数投影） |
| `packages/workspace-provider` / `terminal-provider` / `artifact-provider` | 位置无关的文件/终端/制品 Provider（本地实现） |
| `packages/runtime-codex` | Codex App Server 适配器（协议快照在 `src/protocol/`） |
| `packages/runtime-deepseek` | DeepSeek 参考 Harness（`bin/deepseek-harness`）+ 适配器 |
| `packages/agent-runtime-host` | Agent Execution Host（sidecar 进程） |
| `packages/agent-runtime-client` | Renderer 侧类型化 Host 客户端 |
| `packages/desktop-contracts` | Renderer↔Main IPC 契约 |
| `apps/desktop` | Electron 应用（Forge + Vite + React + Tailwind + Zustand） |

## 快速开始

前置：Node ≥ 24、pnpm ≥ 10、（可选）本机安装并登录 `codex` CLI。

```bash
pnpm install
pnpm build        # 构建所有包（首次必跑）
pnpm dev          # 启动 Aether 桌面应用
```

使用：

1. 左栏 **+** 添加一个本地目录作为 Workspace
2. **Threads → +** 选择 Runtime（Codex / DeepSeek）新建会话
3. DeepSeek 需要先在 **Settings** 填入 API Key（仅保存在本地，经内存注入 Host，不落 runtime 磁盘）
4. 发送消息；Timeline 实时呈现推理/工具/命令/文件变更；审批卡片内 Allow/Reject
5. 底部启动 Files / Terminal / Artifacts / Inspector Surface；文件变更条目点击打开 Diff

## 测试与验证

```bash
pnpm test         # 全部单元/集成测试（76 个）
pnpm typecheck    # 全仓库类型检查

# 冒烟（真实进程链路）
node packages/agent-runtime-host/scripts/smoke-deepseek.mjs   # host→adapter→harness→fake API 完整回合一轮（含审批）
node packages/agent-runtime-host/scripts/smoke-codex.mjs      # 真实 codex app-server 协议验证
node apps/desktop/e2e/run-e2e.mjs                             # Electron 主进程级 E2E（真实全栈，fake API）
```

> 说明：Codex 冒烟在账户配额耗尽时会以 "quota-limited" 通过（协议链路已验证，消息流待配额恢复）。

## 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `AETHER_DEEPSEEK_BASE_URL` | 覆盖 DeepSeek API 地址（自托管/测试） |
| `AETHER_DEEPSEEK_SESSIONS_DIR` | 覆盖 harness 会话 JSONL 目录（默认 `~/.aether/runtimes/deepseek/sessions`） |

## Roadmap（见 arch.md Phase 2+）

Browser Surface、MCP 管理、Sub-Agent 视图、Cloud Backend、Runtime Handoff、企业能力（SSO/RBAC）。
