import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonRpcPeer, RuntimeEventSchema, childProcessStreams } from "@aether/agent-contracts";

/**
 * Full-stack harness test: spawn the real built harness binary, back it with
 * a scripted fake DeepSeek HTTP server, and drive one complete turn including
 * an approval round-trip.
 */
let dir: string;
let apiServer: http.Server;
let apiUrl: string;
let harness: ReturnType<typeof spawn>;
let peer: JsonRpcPeer;
let events: Array<{ seq: number; type: string; payload: unknown }>;

const here = path.dirname(fileURLToPath(import.meta.url));
const harnessBin = path.resolve(here, "../../dist/harness/bin/deepseek-harness.js");

// Scripted model behavior per POST: turn 1 -> dangerous shell tool call,
// turn 2 -> plain reply.
let apiCalls = 0;
const apiScript: Array<(chunk: (obj: unknown) => void) => void> = [
  (send) => {
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "run_shell", arguments: `{"co` } }] } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `mmand":"rm -rf /tmp/junk"}` } }] } }] });
    send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  },
  (send) => {
    send({ choices: [{ delta: { content: "All " } }] });
    send({ choices: [{ delta: { content: "done." } }] });
    send({ choices: [{ delta: {}, finish_reason: "stop" }] });
  },
];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aether-harness-e2e-"));
  apiServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      expect(body).toContain('"stream":true');
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const step = apiScript[Math.min(apiCalls++, apiScript.length - 1)];
      step((obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => apiServer.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`;

  harness = spawn(process.execPath, [harnessBin], { stdio: ["pipe", "pipe", "pipe"] });
  events = [];
  peer = new JsonRpcPeer(childProcessStreams(harness));
  peer.onNotification((method, params) => {
    if (method === "runtimeEvent") {
      const parsed = RuntimeEventSchema.safeParse(params);
      if (parsed.success) {
        events.push({ seq: parsed.data.sequence, type: parsed.data.type, payload: parsed.data.payload });
      }
    }
  });
});

afterAll(async () => {
  harness?.kill();
  await new Promise<void>((r) => apiServer.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, timeoutMs = 15000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("deepseek harness e2e", () => {
  it("initializes, starts a thread and completes a turn with approval", async () => {
    const init = (await peer.request("initialize", {
      clientInfo: { name: "test", title: "Test", version: "0" },
      apiKey: "test-key",
      baseUrl: apiUrl,
      model: "deepseek-chat",
      sessionsDir: path.join(dir, "sessions"),
    })) as { harnessVersion: string };
    expect(init.harnessVersion).toBe("0.1.0");

    const thread = (await peer.request("thread/start", {
      threadId: "th_e2e",
      cwd: dir,
      approvalMode: "askDangerous",
    })) as { externalThreadId: string };
    expect(thread.externalThreadId).toMatch(/^ds_/);

    // Harness asks approval as a server->client request; answer rejected.
    let approvalParams: { approvalId: string } | undefined;
    peer.onRequest(async (method, params) => {
      if (method === "approval/request") {
        approvalParams = params as { approvalId: string };
        return { decision: "approved_once" };
      }
      throw new Error(`unexpected ${method}`);
    });

    const start = (await peer.request("turn/start", {
      threadId: "th_e2e",
      externalThreadId: thread.externalThreadId,
      runId: "run_e2e_1",
      text: "clean up junk",
    })) as { ok: boolean };
    expect(start.ok).toBe(true);

    await waitFor(() => events.some((e) => e.type === "run.completed"));
    const types = events.map((e) => e.type);
    expect(types).toContain("approval.requested");
    expect(types).toContain("approval.resolved");
    expect(types).toContain("command.started");
    expect(types).toContain("command.completed");
    expect(types).toContain("message.delta");
    expect(types).toContain("message.completed");
    expect(approvalParams?.approvalId).toMatch(/^apr_/);
    // sequences strictly increasing
    const seqs = events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    // thread/read replays the same events.
    const read = (await peer.request("thread/read", {
      externalThreadId: thread.externalThreadId,
    })) as { events: unknown[]; lastSequence: number };
    expect(read.events.length).toBeGreaterThanOrEqual(events.length);
    expect(read.lastSequence).toBeGreaterThanOrEqual(seqs.at(-1)!);
  });

  it("lists persisted sessions", async () => {
    const list = (await peer.request("thread/list", {})) as {
      threads: Array<{ externalThreadId: string; title: string }>;
    };
    expect(list.threads.length).toBeGreaterThanOrEqual(1);
    expect(list.threads[0].title).toBe("clean up junk");
  });
});
