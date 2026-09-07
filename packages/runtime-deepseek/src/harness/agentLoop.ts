import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage, ToolCall } from "./deepseekClient.js";
import { streamChat } from "./deepseekClient.js";
import type { ApprovalMode, Risk } from "./approvals.js";
import { shellRisk } from "./approvals.js";
import { executeTool, toolSchemas } from "./tools.js";
import type { SessionStore } from "./sessions.js";

const MAX_ITERATIONS = 25;

export type ApprovalDecision = "approved_once" | "approved_session" | "rejected" | "cancelled";

export interface ApprovalAsk {
  kind: "command" | "fileChange";
  title: string;
  detail: string;
  risk: Risk;
}

export interface LoopContext {
  runId: string;
  cwd: string;
  model: string;
  approvalMode: ApprovalMode;
  apiKey: string;
  baseUrl: string;
  /** Emit a harness event (server wraps it into RuntimeEvent). */
  emit(type: string, payload: unknown): void;
  /** Ask the user for approval; resolves with their decision. */
  requestApproval(ask: ApprovalAsk): Promise<ApprovalDecision>;
  /** Polled between iterations; true means the user pressed stop. */
  interrupted(): boolean;
  /** Injectable for tests; defaults to the real streaming client. */
  stream?: typeof streamChat;
}

function systemPrompt(cwd: string): string {
  return [
    "You are a helpful coding agent working inside a workspace.",
    `The workspace root directory is: ${cwd}`,
    "Always use the provided tools to inspect and modify files instead of guessing.",
    "Prefer edit_file for targeted changes; use write_file only for new files or full rewrites.",
    "After making changes, verify them (e.g. run tests or read the file back).",
    "When the task is done, reply with a concise summary in the user's language.",
  ].join("\n");
}

/** Build a unique item id stable across streaming deltas. */
const itemId = (runId: string, kind: string, n: number): string => `${runId}_${kind}_${n}`;

/**
 * One agent turn: user message -> (stream | tool loop)* -> final message.
 * All state mutations go through the SessionStore; all UI updates go through
 * ctx.emit. Never throws: failures are emitted as run.failed.
 */
export async function runTurn(ctx: LoopContext, store: SessionStore, userText: string): Promise<void> {
  const doStream = ctx.stream ?? streamChat;
  const config = { apiKey: ctx.apiKey, baseUrl: ctx.baseUrl, model: ctx.model };

  ctx.emit("run.started", { runId: ctx.runId });
  store.appendMessage({ role: "user", content: userText });

  // First user message becomes the session title if still default.
  if (store.meta.title === "New chat") {
    await store.setTitle(userText.slice(0, 60));
  }

  let counter = 0;
  const next = (kind: string): string => itemId(ctx.runId, kind, ++counter);

  try {
    if (!ctx.apiKey) {
      throw new Error("No DeepSeek API key configured. Add it in Aether settings.");
    }

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (ctx.interrupted()) {
        ctx.emit("run.cancelled", { runId: ctx.runId });
        return;
      }

      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt(ctx.cwd) },
        ...store.chatMessages(),
      ];

      const reasoningId = next("reason");
      const msgId = next("msg");
      const result = await doStream(config, messages, toolSchemas(), {
        onContentDelta: (d) => ctx.emit("message.delta", { itemId: msgId, delta: d }),
        onReasoningDelta: (d) => ctx.emit("reasoning.delta", { itemId: reasoningId, delta: d }),
      });
      if (result.reasoning) ctx.emit("reasoning.completed", { itemId: reasoningId, text: result.reasoning });

      if (result.toolCalls.length > 0) {
        // Close any streamed content that preceded the tool calls.
        if (result.content) {
          ctx.emit("message.completed", { itemId: msgId, text: result.content });
        }
        // Assistant message with tool calls becomes part of the conversation.
        store.appendMessage({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        for (const call of result.toolCalls) {
          await handleToolCall(ctx, store, call);
        }
        continue; // next iteration lets the model see tool results
      }

      // Final assistant message.
      ctx.emit("message.completed", { itemId: msgId, text: result.content });
      store.appendMessage({ role: "assistant", content: result.content });
      ctx.emit("run.completed", { runId: ctx.runId });
      return;
    }

    ctx.emit("run.failed", { runId: ctx.runId, message: `exceeded ${MAX_ITERATIONS} tool iterations` });
  } catch (err) {
    ctx.emit("run.failed", { runId: ctx.runId, message: (err as Error).message });
  }
}

async function handleToolCall(ctx: LoopContext, store: SessionStore, call: ToolCall): Promise<void> {
  const toolId = `${ctx.runId}_tool_${call.name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    /* handled below */
  }

  if (call.name === "run_shell") {
    const command = String(args.command ?? "");
    ctx.emit("command.started", { itemId: toolId, command });
    ctx.emit("tool.started", { itemId: toolId, tool: call.name, input: command });

    const { risk, needsApproval } = shellRisk(command, ctx.approvalMode);
    if (needsApproval) {
      // requestApproval emits approval.requested/resolved events itself.
      const decision = await ctx.requestApproval({
        kind: "command",
        title: "Run command",
        detail: command,
        risk,
      });
      if (decision === "rejected" || decision === "cancelled") {
        const out = "User rejected this command execution.";
        ctx.emit("command.completed", { itemId: toolId, exitCode: null });
        ctx.emit("tool.completed", { itemId: toolId, tool: call.name, output: out, ok: false });
        store.appendMessage({ role: "tool", content: out, tool_call_id: call.id });
        return;
      }
    }

    const result = await executeTool("run_shell", args, { cwd: ctx.cwd }, (delta) =>
      ctx.emit("command.output", { itemId: toolId, delta }),
    );
    const exitCode = result.ok ? 0 : 1;
    ctx.emit("command.completed", { itemId: toolId, exitCode });
    ctx.emit("tool.completed", { itemId: toolId, tool: call.name, output: result.output, ok: result.ok });
    store.appendMessage({ role: "tool", content: result.output.slice(0, 16 * 1024), tool_call_id: call.id });
    return;
  }

  ctx.emit("tool.started", {
    itemId: toolId,
    tool: call.name,
    input: JSON.stringify(args).slice(0, 500),
  });

  // Capture existence before the tool runs so new files report as "added".
  let existedBefore = true;
  if (call.name === "write_file" || call.name === "edit_file") {
    const rel = String(args.path ?? "");
    existedBefore = await fs
      .stat(path.join(ctx.cwd, rel))
      .then(() => true)
      .catch(() => false);
  }

  const result = await executeTool(call.name, args, { cwd: ctx.cwd });

  if ((call.name === "write_file" || call.name === "edit_file") && result.ok) {
    const rel = String(args.path ?? "");
    ctx.emit("filechange.detected", {
      itemId: toolId,
      path: rel,
      changeType: existedBefore ? "modified" : "added",
    });
  }

  ctx.emit("tool.completed", { itemId: toolId, tool: call.name, output: result.output, ok: result.ok });
  store.appendMessage({ role: "tool", content: result.output.slice(0, 16 * 1024), tool_call_id: call.id });
}
