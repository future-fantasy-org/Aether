/** Minimal streaming client for DeepSeek's OpenAI-compatible chat API. */

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamHandlers {
  onContentDelta(s: string): void;
  onReasoningDelta(s: string): void;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

interface SseChoiceDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface SseChunk {
  choices?: Array<{ delta?: SseChoiceDelta; finish_reason?: string | null }>;
}

export class DeepSeekApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DeepSeekApiError";
  }
}

/** Stream one chat completion. Throws DeepSeekApiError on non-2xx. */
export async function streamChat(
  config: DeepSeekConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      stream: true,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const hint =
      res.status === 401
        ? "DeepSeek API auth failed (check API key in settings)"
        : `DeepSeek API error ${res.status}: ${body.slice(0, 300)}`;
    throw new DeepSeekApiError(res.status, hint);
  }

  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCallMap = new Map<number, ToolCall>();
  let finishReason: string | null = null;

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trimEnd();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk: SseChunk;
      try {
        chunk = JSON.parse(data) as SseChunk;
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        contentParts.push(delta.content);
        handlers.onContentDelta(delta.content);
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        reasoningParts.push(delta.reasoning_content);
        handlers.onReasoningDelta(delta.reasoning_content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallMap.get(tc.index);
          if (!existing) {
            toolCallMap.set(tc.index, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            });
          } else {
            if (tc.id) existing.id += tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          }
        }
      }
    }
  }

  return {
    content: contentParts.join(""),
    reasoning: reasoningParts.join(""),
    toolCalls: [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
    finishReason,
  };
}
