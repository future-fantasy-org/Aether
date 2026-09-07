import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { streamChat, type ChatMessage, type ToolSchema } from "./deepseekClient.js";

let server: http.Server;
let baseUrl = "";
let handler: (body: string) => string = () => "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(handler(body));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const noTools: ToolSchema[] = [];
const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("streamChat", () => {
  it("streams content deltas across split chunks", async () => {
    // Deliberately split SSE lines mid-JSON to test buffering.
    handler = () => {
      const a = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`;
      const b = `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\ndata: [DONE]\n\n`;
      return a.slice(0, 20) + a.slice(20) + b;
    };
    const deltas: string[] = [];
    const result = await streamChat(
      { apiKey: "k", baseUrl, model: "deepseek-chat" },
      msgs,
      noTools,
      { onContentDelta: (d) => deltas.push(d), onReasoningDelta: () => {} },
    );
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result.content).toBe("Hello");
    expect(result.finishReason).toBeNull();
  });

  it("aggregates reasoning_content and tool_call fragments", async () => {
    handler = () =>
      [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think " } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hard" } }] })}`,
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_", arguments: "" } }] } }],
        })}`,
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: '{"pa' } }] } }],
        })}`,
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }],
        })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n");
    const reasoning: string[] = [];
    const result = await streamChat(
      { apiKey: "k", baseUrl, model: "deepseek-reasoner" },
      msgs,
      noTools,
      { onContentDelta: () => {}, onReasoningDelta: (d) => reasoning.push(d) },
    );
    expect(reasoning).toEqual(["think ", "hard"]);
    expect(result.reasoning).toBe("think hard");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
    ]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("throws a helpful error on 401", async () => {
    server.close();
    const authServer = http.createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "auth" }));
    });
    await new Promise<void>((r) => authServer.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(authServer.address() as { port: number }).port}`;
    await expect(
      streamChat({ apiKey: "bad", baseUrl: url, model: "m" }, msgs, noTools, {
        onContentDelta: () => {},
        onReasoningDelta: () => {},
      }),
    ).rejects.toThrow(/API key/);
    await new Promise<void>((r) => authServer.close(() => r()));
  });
});
