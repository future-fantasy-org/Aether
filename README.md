# Aether

> **One workspace. Every agent.**  
> **一个工作台，连接所有 Agent。**

Aether is a universal desktop workbench for AI agents, built by **FutureFantasy Tech**.

Instead of locking you into a single model or agent runtime, Aether provides one consistent workspace for working with different agent backends — from local runtimes such as **Codex App Server** and **DeepSeek Harness**, to future cloud and remote agents.

Aether focuses on the experience layer: conversations, agent activity, plans, tool calls, terminal sessions, file changes, diffs, approvals, artifacts, and execution status are normalized into one unified interface.

Underneath, different runtimes remain independent. Aether connects to them through a runtime-agnostic adapter architecture, so new agents, protocols, local environments, and cloud execution backends can be added without redesigning the entire UI.

Our goal is simple:

**Build the desktop workspace where every agent can work.**

---

Aether 是由 **FutureFantasy Tech** 打造的通用 AI Agent 桌面工作台。

我们不希望用户被绑定在某一个模型、某一个 CLI 或某一种 Agent Runtime 上。

Aether 提供一个统一的工作空间，可以同时承载 **Codex App Server、DeepSeek Harness** 等本地 Agent Runtime，并为未来的 **Codex Cloud、DeepSeek Cloud、远程 Agent、企业私有 Agent** 提供统一接入能力。

在 Aether 中，不同 Runtime 的执行细节会被统一映射为一致的用户体验，包括：

- Agent 对话与任务执行
- Plan / Reasoning / Activity Timeline
- Tool Call 与 MCP
- Terminal 与远程 Shell
- 文件浏览、编辑与 Diff
- Approval 与权限确认
- Browser / Computer Use
- Artifact 与成果管理
- Local / Cloud Agent 状态
- 多 Agent 协作与任务切换

Aether 本身不重新实现 Agent Runtime。

它专注于构建 Agent 的 **展示层、交互层和工作空间层**，通过 Runtime Adapter、Capability Negotiation 和统一事件模型连接不同 Agent Backend。

这意味着未来无论 Agent 运行在：

**你的电脑、Docker、远程服务器、企业私有云，还是模型厂商的 Cloud Agent 中，**

都可以在 Aether 中获得一致的工作体验。

**Aether 的目标不是成为另一个 Agent。**

**而是成为所有 Agent 工作的地方。**
