import { canTransition, isTerminalRunStatus } from "@aether/agent-domain";
import type { AgentItem, Run, RunStatus } from "@aether/agent-domain";
import type {
  ApprovalRequest,
  RuntimeEvent,
  RuntimeEventType,
} from "@aether/agent-contracts";
import { RuntimeEventSchema } from "@aether/agent-contracts";
import type { ThreadProjection } from "./state.js";

const RUN_STATUS_BY_EVENT: Partial<Record<RuntimeEventType, RunStatus>> = {
  "run.started": "RUNNING",
  "run.completed": "COMPLETED",
  "run.failed": "FAILED",
  "run.cancelled": "CANCELLED",
  "run.interrupted": "INTERRUPTED",
};

/**
 * Pure reducer: fold one RuntimeEvent into a ThreadProjection.
 * Returns a new projection; input is never mutated.
 */
export function projectEvent(state: ThreadProjection, event: RuntimeEvent): ThreadProjection {
  const parsed = RuntimeEventSchema.safeParse(event);
  if (!parsed.success) return state;
  const ev = parsed.data;
  if (ev.sequence <= state.lastSequence) return state; // idempotent replay

  let items = state.items;
  let runs = state.runs;
  let activeRunId = state.activeRunId;
  let pendingApprovals = state.pendingApprovals;
  let error = state.error;

  const updateItem = (itemId: string, fn: (item: AgentItem) => AgentItem): void => {
    const idx = items.findIndex((i) => i.id === itemId);
    if (idx >= 0) items = [...items.slice(0, idx), fn(items[idx]), ...items.slice(idx + 1)];
  };
  const appendItem = (item: AgentItem): void => {
    items = [...items, item];
  };
  const newItem = (id: string): AgentItem => ({
    id,
    threadId: ev.threadId,
    runId: ev.runId,
    createdAt: ev.timestamp,
  } as unknown as AgentItem); // narrowed by callers before use

  switch (ev.type) {
    case "thread.started":
    case "thread.titleUpdated":
      break; // metadata handled by stores, not timeline items

    case "run.started":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
    case "run.interrupted": {
      const p = (ev.payload ?? {}) as { runId?: string; message?: string };
      const runId = p.runId ?? ev.runId ?? "unknown";
      const target = RUN_STATUS_BY_EVENT[ev.type]!;
      const prev = runs[runId];
      if (!prev) {
        const run: Run = {
          id: runId,
          threadId: ev.threadId,
          status: target,
          startedAt: ev.timestamp,
          endedAt: isTerminalRunStatus(target) ? ev.timestamp : undefined,
          error: target === "FAILED" ? p.message : undefined,
        };
        runs = { ...runs, [runId]: run };
      } else if (canTransition(prev.status, target)) {
        runs = {
          ...runs,
          [runId]: {
            ...prev,
            status: target,
            endedAt: isTerminalRunStatus(target) ? ev.timestamp : prev.endedAt,
            error: target === "FAILED" ? (p.message ?? prev.error) : prev.error,
          },
        };
      }
      if (ev.type === "run.started") activeRunId = runId;
      else if (runId === activeRunId && isTerminalRunStatus(target)) activeRunId = undefined;
      if (ev.type === "run.failed") error = p.message ?? "run failed";
      break;
    }

    case "message.delta": {
      const p = ev.payload as { itemId: string; delta: string };
      const existing = items.find((i) => i.id === p.itemId && i.type === "agent_message");
      if (existing && existing.type === "agent_message") {
        updateItem(p.itemId, (i) =>
          i.type === "agent_message" ? { ...i, text: i.text + p.delta, streaming: true } : i,
        );
      } else {
        appendItem({
          ...newItem(p.itemId),
          type: "agent_message",
          text: p.delta,
          streaming: true,
        });
      }
      break;
    }
    case "message.completed": {
      const p = ev.payload as { itemId: string; text: string };
      const existing = items.find((i) => i.id === p.itemId && i.type === "agent_message");
      if (existing) {
        updateItem(p.itemId, (i) =>
          i.type === "agent_message" ? { ...i, text: p.text, streaming: false } : i,
        );
      } else {
        appendItem({ ...newItem(p.itemId), type: "agent_message", text: p.text, streaming: false });
      }
      break;
    }

    case "reasoning.delta": {
      const p = ev.payload as { itemId: string; delta: string };
      const existing = items.find((i) => i.id === p.itemId && i.type === "reasoning_summary");
      if (existing) {
        updateItem(p.itemId, (i) =>
          i.type === "reasoning_summary" ? { ...i, text: i.text + p.delta, streaming: true } : i,
        );
      } else {
        appendItem({
          ...newItem(p.itemId),
          type: "reasoning_summary",
          text: p.delta,
          streaming: true,
        });
      }
      break;
    }
    case "reasoning.completed": {
      const p = ev.payload as { itemId: string; text: string };
      const existing = items.find((i) => i.id === p.itemId && i.type === "reasoning_summary");
      if (existing) {
        updateItem(p.itemId, (i) =>
          i.type === "reasoning_summary" ? { ...i, text: p.text, streaming: false } : i,
        );
      } else {
        appendItem({
          ...newItem(p.itemId),
          type: "reasoning_summary",
          text: p.text,
          streaming: false,
        });
      }
      break;
    }

    case "plan.updated": {
      const p = ev.payload as { itemId: string; steps: Array<{ text: string; status: "pending" | "in_progress" | "completed" }> };
      const existing = items.find((i) => i.id === p.itemId && i.type === "plan");
      if (existing) {
        updateItem(p.itemId, (i) => (i.type === "plan" ? { ...i, steps: p.steps } : i));
      } else {
        appendItem({ ...newItem(p.itemId), type: "plan", steps: p.steps });
      }
      break;
    }

    case "tool.started": {
      const p = ev.payload as { itemId: string; tool: string; input?: string };
      appendItem({
        ...newItem(p.itemId),
        type: "tool_call",
        tool: p.tool,
        input: p.input,
        status: "running",
      });
      break;
    }
    case "tool.completed": {
      const p = ev.payload as { itemId: string; tool: string; output?: string; ok: boolean };
      updateItem(p.itemId, (i) =>
        i.type === "tool_call"
          ? { ...i, output: p.output, status: p.ok ? "completed" : "failed" }
          : i,
      );
      break;
    }

    case "command.started": {
      const p = ev.payload as { itemId: string; command: string };
      appendItem({
        ...newItem(p.itemId),
        type: "command",
        command: p.command,
        output: "",
        status: "running",
      });
      break;
    }
    case "command.output": {
      const p = ev.payload as { itemId: string; delta: string };
      updateItem(p.itemId, (i) =>
        i.type === "command" ? { ...i, output: i.output + p.delta } : i,
      );
      break;
    }
    case "command.completed": {
      const p = ev.payload as { itemId: string; exitCode: number | null };
      updateItem(p.itemId, (i) =>
        i.type === "command"
          ? { ...i, exitCode: p.exitCode ?? undefined, status: p.exitCode === null || p.exitCode === 0 ? "completed" : "failed" }
          : i,
      );
      break;
    }

    case "filechange.detected": {
      const p = ev.payload as { itemId: string; path: string; changeType: "added" | "modified" | "deleted" };
      const existing = items.find((i) => i.id === p.itemId && i.type === "file_change");
      if (!existing) {
        appendItem({
          ...newItem(p.itemId),
          type: "file_change",
          path: p.path,
          changeType: p.changeType,
          additions: 0,
          deletions: 0,
        });
      }
      break;
    }
    case "filechange.patch": {
      const p = ev.payload as { itemId: string; additions: number; deletions: number; patch: string };
      const existing = items.find((i) => i.id === p.itemId && i.type === "file_change");
      if (existing) {
        updateItem(p.itemId, (i) =>
          i.type === "file_change"
            ? { ...i, additions: p.additions, deletions: p.deletions, patch: p.patch }
            : i,
        );
      } else {
        appendItem({
          ...newItem(p.itemId),
          type: "file_change",
          path: "(unknown)",
          changeType: "modified",
          additions: p.additions,
          deletions: p.deletions,
          patch: p.patch,
        });
      }
      break;
    }

    case "approval.requested": {
      const p = ev.payload as ApprovalRequest;
      pendingApprovals = [...pendingApprovals, p];
      appendItem({
        ...newItem(p.approvalId),
        type: "approval",
        approvalId: p.approvalId,
        title: p.title,
        detail: p.detail,
        risk: p.risk,
        decision: "pending",
      });
      break;
    }
    case "approval.resolved": {
      const p = ev.payload as { approvalId: string; decision: "approved_once" | "approved_session" | "rejected" | "cancelled" };
      pendingApprovals = pendingApprovals.filter((a) => a.approvalId !== p.approvalId);
      updateItem(p.approvalId, (i) =>
        i.type === "approval" ? { ...i, decision: p.decision } : i,
      );
      break;
    }

    case "error": {
      const p = ev.payload as { message: string; fatal: boolean };
      appendItem({ ...newItem(`err_${ev.eventId}`), type: "error", message: p.message, fatal: p.fatal });
      if (p.fatal) error = p.message;
      break;
    }
    case "notice": {
      const p = ev.payload as { message: string };
      appendItem({ ...newItem(`ntc_${ev.eventId}`), type: "notice", message: p.message });
      break;
    }
  }

  return {
    ...state,
    items,
    runs,
    activeRunId,
    pendingApprovals,
    lastSequence: ev.sequence,
    error,
  };
}
