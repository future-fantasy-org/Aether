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

## 打包（本地）

```bash
pnpm --filter aether-desktop run package   # 平台目录产物（out/Aether-darwin-arm64/Aether.app）
pnpm --filter aether-desktop run make      # 安装器：macOS .dmg + .zip / Windows Setup.exe
```

打包链路（`apps/desktop/scripts/package-prepare.mjs`）：

1. `pnpm --filter=@aether/agent-runtime-host deploy --prod --legacy .pack/aether-agent-host` —— 把 Agent Execution Host 连同全部运行时依赖物化为自包含目录
2. 修复 `node-pty` prebuilds 的 `spawn-helper` 执行位；按需为 `macos-alias`/`fs-xattr` 跑 node-gyp（npm 隐式构建而 pnpm 不会）
3. `forge.config.ts` 以 `extraResource` 把该目录塞进 `Contents/Resources/aether-agent-host`，打包后 sidecar 用 `ELECTRON_RUN_AS_NODE` 从 Resources 启动（与 dev 同一代码路径）

## CI 与发布

- **`ci.yml`**：push/PR 质量门 —— Linux 上 `pnpm build` → `pnpm test`（76 测试）→ `pnpm typecheck`
- **`release.yml`**（lime 同款三段式，tag `v*` 触发或手动 dispatch）：
  1. `prepare_release`（ubuntu）：校验 tag 与 `apps/desktop/package.json` 版本一致，自动生成 Notes，创建 **Draft** Release
  2. `build` 矩阵（fail-fast 关闭）：`macos-15`（arm64 dmg+zip）/ `macos-15-intel`（x64 dmg+zip）/ `windows-2022`（x64 Squirrel Setup.exe），上传 artifact
  3. `publish_release_assets`：`gh release upload --clobber` 附上产物并转为正式 + latest

发布一个版本：

```bash
# 1. 更新 apps/desktop/package.json 的 version（与 tag 一致）
git tag v0.1.0 && git push origin v0.1.0
```

代码签名（可选）：配置 repo secrets 后自动启用 —— macOS 导入证书并签名+公证（`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`KEYCHAIN_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`），Windows 签名 Squirrel 安装器（`WINDOWS_SIGNING_CERTIFICATE`、`WINDOWS_SIGNING_CERTIFICATE_PASSWORD`）。未配置时照常构建未签名产物。

## 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `AETHER_DEEPSEEK_BASE_URL` | 覆盖 DeepSeek API 地址（自托管/测试） |
| `AETHER_DEEPSEEK_SESSIONS_DIR` | 覆盖 harness 会话 JSONL 目录（默认 `~/.aether/runtimes/deepseek/sessions`） |

## Roadmap（见 arch.md Phase 2+）

Browser Surface、MCP 管理、Sub-Agent 视图、Cloud Backend、Runtime Handoff、企业能力（SSO/RBAC）。
