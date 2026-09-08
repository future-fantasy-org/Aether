# Aether Background Run（Detached Run）设计

日期：2026-09-08 ｜ 状态：已批准（用户选定：按需存活 + 审批超时自动拒绝）
依据：arch.md §16（Detached Run）、§34（Cloud 前置）

## 目标

Run 的生命周期独立于 Electron：退出 Aether 后活跃 Run 继续执行并持续落盘事件；
重开 Aether 时 reconnect 存活 host，replay 恢复 Timeline，live 续流。

## 非目标

- 常驻 daemon / 服务注册（用户已否决）
- 事件内存重放协议（readThread 快照 + live 续流已覆盖，投影 seq 去重幂等）
- Cloud Transport（后续子项目，本设计是其前置）

## 核心决策

| 决策 | 选择 |
|---|---|
| 存活策略 | 按需存活：无活跃 Run 随 Electron 退；有则孤儿化续跑 |
| 通信通道 | stdio（bootstrap/主通道）+ Unix domain socket / Windows named pipe（重连通道） |
| 重连续传 | 客户端重连后重新 `readThread`（快照）+ 订阅 live；无专用重放协议 |
| 悬置审批 | 孤儿模式下超时自动 `rejected`；默认 30 分钟，`AETHER_APPROVAL_TIMEOUT_MS` 可配 |
| 活跃判定 | host 从事件流投影 run 状态（RUNNING/WAITING_* 为活跃） |

## Host 生命周期状态机

```text
spawn（Electron，detached，stdio + UDS 双通道，写会话文件）
  SERVING（primary = stdio）
    ├─ stdio EOF & activeRuns = 0 → stop() & exit(0)
    ├─ stdio EOF & activeRuns > 0 → ORPHAN（等 UDS 客户端）
    ├─ socket 连入 → primary 切换到 socket peer（SERVING'）
    └─ host/shutdown 请求（Electron 仅在 activeRuns = 0 时调用）→ exit(0)
  ORPHAN
    ├─ socket 客户端连入 + ping → SERVING'（事件已落盘，客户端自行 replay）
    ├─ activeRuns 归零且无 primary → 延迟 2s exit(0)（防连接竞态）
    ├─ 审批超时 → 内部 respondApproval(rejected) → Run 走 rejected 分支
    └─ SIGTERM/SIGINT → stop() & exit(0)
```

会话文件 `~/.aether/host-session.json`（`AETHER_HOME` 可覆盖）：
`{ protocol: 1, pid, socketPath, startedAt }`；host 启动时写入、退出前删除；
读到陈旧文件（pid 不存活或 socket ping 失败）时清理重建。

socket 路径：`<AETHER_HOME>/host.sock`（POSIX）/ `\\.\pipe\aether-host`（Windows）。

## 组件与改动

- `agent-contracts`：`socketStreams(sock)`；`HostStatusKind` 增加 `"reconnected"`；
  `HOST_METHODS.hostStatus` → `{ activeRuns, orphan, socketPath, startedAt }`。
- `agent-runtime-host`：
  - `runTracker.ts`：从 RuntimeEvent 投影 `Map<runId, status>`（纯逻辑，单测）。
  - `hostLifecycle.ts`：EOF/断连判定、孤儿进入/退出、审批超时计时、延迟自杀（依赖注入 timers/streams，单测）。
  - `host.ts`：primary peer 语义（通知只发 primary）、UDS server、会话文件管理、
    `hostStatus` 方法、审批超时回调走内部 `respondApproval`。
  - `bin/aether-agent-host.ts`：装配双通道 + 生命周期。
- `desktop main`：
  - `sidecar.ts`：启动时读会话文件 → `process.kill(pid, 0)` + socket ping → 存活则复用
    （状态 `reconnected`），否则 spawn（现有崩溃重启保留）。
  - `main.ts`：`before-quit` → `hostStatus.activeRuns > 0` 则跳过 shutdown 直接退出。
  - settings → spawn env `AETHER_APPROVAL_TIMEOUT_MS`。
- `renderer`：hostStatus `reconnected` → 提示条 + 刷新当前 thread（快照 + live 续流）；
  设置页新增后台审批超时（分钟）。

## 错误处理

- socket 监听冲突：陈旧文件 → 探活失败 → 删除后重试一次；仍失败 → stdio-only 降级
  （后台能力不可用但会话正常，Electron 退出即随退）。
- 孤儿期间 harness/codex 子进程崩溃：现有 error 事件 → run FAILED → activeRuns 归零 → 自杀路径。
- 会话文件损坏：按不存在处理。

## 测试

- 单测：runTracker（事件→状态）；hostLifecycle（EOF 分支、审批超时、防抖自杀——注入 fake clock）。
- 冒烟 `scripts/smoke-detach.mjs`：fake SSE API → stdio 起 host → startRun → 断 stdio →
  断言进程存活 + 会话文件在 → socket 重连 ping → readThread 含孤儿期事件 → 存活 Run 完成后 host 自杀。
- 现有 76 测试回归 + desktop E2E 不变。
