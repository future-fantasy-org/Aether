import type { AgentItem, PlanStep } from "@aether/agent-domain";
import type {
  ApprovalDecisionValue,
  ApprovalKind,
  RuntimeEventType,
} from "@aether/agent-contracts";

/**
 * Pure Codex App Server -> Aether mappings. Wire data is treated as
 * `unknown` and validated structurally; the protocol snapshot under
 * src/protocol documents the source shapes (codex-cli 0.144.1).
 */

// ---- structural wire types (subset actually consumed) ----

interface WireItem {
  type: string;
  id: string;
  [k: string]: unknown;
}
interface WireThreadItem extends WireItem {}

const asString = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Extract command string from a commandExecution item's `command` field. */
function commandText(item: WireThreadItem): string {
  const c = item.command;
  if (typeof c === "string") return c;
  return JSON.stringify(c ?? "");
}

/** Map a Codex ThreadItem snapshot into an AgentItem (thread/read path). */
export function mapThreadItem(threadId: string, item: unknown, timestamp: string): AgentItem | undefined {
  if (!item || typeof item !== "object") return undefined;
  const it = item as WireThreadItem;
  const base = { id: it.id, threadId, createdAt: timestamp };
  switch (it.type) {
    case "userMessage": {
      const first = asArray(it.content).find(
        (c) => (c as { type?: string })?.type === "text",
      ) as { text?: string } | undefined;
      return { ...base, type: "user_message", text: asString(first?.text) };
    }
    case "agentMessage":
      return { ...base, type: "agent_message", text: asString(it.text), streaming: false };
    case "reasoning":
      return {
        ...base,
        type: "reasoning_summary",
        text: asArray(it.summary).join("\n") || asArray(it.content).join("\n"),
        streaming: false,
      };
    case "plan":
      return {
        ...base,
        type: "plan",
        steps: [] as PlanStep[],
      };
    case "commandExecution": {
      const status = asString(it.status, "inProgress");
      return {
        ...base,
        type: "command",
        command: commandText(it),
        output: "",
        exitCode: status === "completed" ? 0 : status === "failed" ? 1 : undefined,
        status: status === "completed" ? "completed" : status === "failed" || status === "declined" ? "failed" : "running",
      };
    }
    case "fileChange": {
      const changes = asArray(it.changes) as Array<{ path?: string; kind?: string; diff?: string }>;
      const first = changes[0];
      const patch = changes.map((c) => c.diff ?? "").join("\n");
      return {
        ...base,
        type: "file_change",
        path: asString(first?.path, "(unknown)"),
        changeType: first?.kind === "added" ? "added" : first?.kind === "deleted" ? "deleted" : "modified",
        additions: (patch.match(/^\+[^+]/gm) ?? []).length,
        deletions: (patch.match(/^-[^-]/gm) ?? []).length,
        patch: patch || undefined,
      };
    }
    case "mcpToolCall":
    case "dynamicToolCall":
      return {
        ...base,
        type: "tool_call",
        tool: asString(it.tool, asString(it.namespace)),
        input: JSON.stringify(it.arguments ?? {}).slice(0, 500),
        output: it.result ? JSON.stringify(it.result).slice(0, 2000) : undefined,
        status: asString(it.status) === "completed" ? "completed" : asString(it.status) === "failed" ? "failed" : "running",
      };
    case "webSearch":
      return { ...base, type: "search", query: asString(it.query) };
    default:
      return undefined; // hookPrompt, contextCompaction, imageGeneration, ...
  }
}

export interface MappedEvent {
  type: RuntimeEventType;
  payload: unknown;
  /** turnId from codex wire data, for run association by the adapter. */
  turnId?: string;
}

interface NotificationCtx {
  /** Aether thread id for the wire threadId. */
  threadIdFor(wireThreadId: string): string | undefined;
  /** runId for a codex turnId. */
  runIdFor(turnId: string): string;
}

/** Map one app-server notification into 0..n RuntimeEvents. */
export function mapNotification(
  ctx: NotificationCtx,
  method: string,
  params: unknown,
): MappedEvent[] {
  const p = (params ?? {}) as Record<string, unknown>;
  const threadId = ctx.threadIdFor(asString(p.threadId));
  if (!threadId) return []; // not a thread we track
  const runId = p.turnId ? ctx.runIdFor(asString(p.turnId)) : undefined;
  const ev = (type: RuntimeEventType, payload: unknown, turnId?: string): MappedEvent[] => [
    { type, payload, turnId: turnId ?? (p.turnId ? asString(p.turnId) : undefined) },
  ];

  switch (method) {
    case "turn/started":
      return ev("run.started", { runId: ctx.runIdFor(asString((p.turn as { id?: string })?.id)) }, asString((p.turn as { id?: string })?.id));
    case "turn/completed": {
      const turn = (p.turn ?? {}) as { id?: string; status?: string };
      const rid = ctx.runIdFor(asString(turn.id));
      const status = asString(turn.status, "completed");
      if (status === "failed") return ev("run.failed", { runId: rid, message: "turn failed" }, asString(turn.id));
      if (status === "interrupted") return ev("run.cancelled", { runId: rid }, asString(turn.id));
      return ev("run.completed", { runId: rid }, asString(turn.id));
    }
    case "item/agentMessage/delta":
      return ev("message.delta", { itemId: asString(p.itemId), delta: asString(p.delta) });
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return ev("reasoning.delta", { itemId: asString(p.itemId), delta: asString(p.delta) });
    case "item/started": {
      const item = p.item as WireThreadItem | undefined;
      if (!item) return [];
      if (item.type === "commandExecution") {
        return ev("command.started", { itemId: item.id, command: commandText(item) });
      }
      if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
        return ev("tool.started", {
          itemId: item.id,
          tool: asString(item.tool, asString(item.namespace)),
          input: JSON.stringify(item.arguments ?? {}).slice(0, 500),
        });
      }
      return [];
    }
    case "item/completed": {
      const item = p.item as WireThreadItem | undefined;
      if (!item) return [];
      switch (item.type) {
        case "agentMessage":
          return ev("message.completed", { itemId: item.id, text: asString(item.text) });
        case "commandExecution": {
          const status = asString(item.status, "completed");
          const exitCode = status === "completed" ? 0 : status === "failed" ? 1 : null;
          return ev("command.completed", { itemId: item.id, exitCode });
        }
        case "fileChange": {
          const changes = asArray(item.changes) as Array<{ path?: string; kind?: string; diff?: string }>;
          const first = changes[0];
          const out: MappedEvent[] = [
            {
              type: "filechange.detected",
              payload: {
                itemId: item.id,
                path: asString(first?.path, "(unknown)"),
                changeType:
                  first?.kind === "added" ? "added" : first?.kind === "deleted" ? "deleted" : "modified",
              },
              turnId: p.turnId ? asString(p.turnId) : undefined,
            },
          ];
          const patch = changes.map((c) => c.diff ?? "").join("\n");
          if (patch) {
            out.push({
              type: "filechange.patch",
              payload: {
                itemId: item.id,
                additions: (patch.match(/^\+[^+]/gm) ?? []).length,
                deletions: (patch.match(/^-[^-]/gm) ?? []).length,
                patch,
              },
              turnId: p.turnId ? asString(p.turnId) : undefined,
            });
          }
          return out;
        }
        case "reasoning":
          return ev("reasoning.completed", {
            itemId: item.id,
            text: asArray(item.summary).join("\n") || asArray(item.content).join("\n"),
          });
        case "mcpToolCall":
        case "dynamicToolCall":
          return ev("tool.completed", {
            itemId: item.id,
            tool: asString(item.tool),
            output: item.result ? JSON.stringify(item.result).slice(0, 2000) : undefined,
            ok: asString(item.status) !== "failed",
          });
        default:
          return [];
      }
    }
    case "item/commandExecution/outputDelta":
    case "command/exec/outputDelta":
      return ev("command.output", { itemId: asString(p.itemId), delta: asString(p.delta) });
    case "item/fileChange/patchUpdated": {
      const changes = asArray(p.changes) as Array<{ diff?: string }>;
      const patch = changes.map((c) => c.diff ?? "").join("\n");
      return ev("filechange.patch", {
        itemId: asString(p.itemId),
        additions: (patch.match(/^\+[^+]/gm) ?? []).length,
        deletions: (patch.match(/^-[^-]/gm) ?? []).length,
        patch,
      });
    }
    case "turn/plan/updated": {
      const steps = asArray(p.plan).map((s) => {
        const step = s as { text?: string; status?: string };
        const status =
          step.status === "completed" ? "completed" : step.status === "in_progress" ? "in_progress" : "pending";
        return { text: asString(step.text), status } as PlanStep;
      });
      const turnId = asString(p.turnId);
      return ev("plan.updated", { itemId: `plan_${turnId}`, steps });
    }
    case "error":
      return ev("error", {
        message: asString((p.error as { message?: string })?.message, "codex error"),
        fatal: p.willRetry === false,
      });
    default:
      return [];
  }
}

// ---- Approvals ----

export interface MappedApproval {
  kind: ApprovalKind;
  title: string;
  detail: string;
  risk: "low" | "medium" | "high";
}

const HIGH_RISK = [/rm\s+-[a-zA-Z]*r/, /\bsudo\b/, /mkfs/, /dd\s+if=/, /--force/];

/** Map app-server approval requests ("item/commandExecution/requestApproval" etc). */
export function mapApprovalRequest(method: string, params: unknown): MappedApproval | undefined {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = p.command as { command?: string } | string | undefined;
      const cmd =
        typeof command === "string" ? command : asString(command?.command, JSON.stringify(command ?? ""));
      const risk = HIGH_RISK.some((re) => re.test(cmd)) ? "high" : "medium";
      return { kind: "command", title: "Run command", detail: cmd, risk };
    }
    case "item/fileChange/requestApproval": {
      const changes = asArray(p.changes) as Array<{ path?: string }>;
      const files = changes.map((c) => asString(c.path)).filter(Boolean).join(", ");
      return {
        kind: "fileChange",
        title: "Apply file changes",
        detail: files || "file modifications",
        risk: "medium",
      };
    }
    case "item/permissions/requestApproval":
      return {
        kind: "permission",
        title: "Grant permissions",
        detail: asString(p.reason, "additional permissions requested"),
        risk: "low",
      };
    default:
      return undefined;
  }
}

/** Aether decision -> codex decision value. */
export function mapDecision(decision: ApprovalDecisionValue): string {
  switch (decision) {
    case "approved_once":
      return "accept";
    case "approved_session":
      return "acceptForSession";
    case "rejected":
      return "decline";
    case "cancelled":
      return "cancel";
  }
}

/** Aether approvalMode -> codex AskForApproval policy. */
export function mapApprovalMode(
  mode: "askAlways" | "askDangerous" | "never" | undefined,
): "untrusted" | "on-request" | "never" | undefined {
  switch (mode) {
    case "askAlways":
      return "untrusted";
    case "askDangerous":
      return "on-request";
    case "never":
      return "never";
    default:
      return undefined;
  }
}
