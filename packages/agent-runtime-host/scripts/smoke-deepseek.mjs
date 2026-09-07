#!/usr/bin/env node
/**
 * DeepSeek runtime smoke through the real Agent Execution Host:
 * host (spawned bin) -> DeepSeekAdapter -> harness -> fake DeepSeek API.
 * Covers: thread create, run with tool call, approval round trip, completion.
 *
 * Usage: AETHER_DEEPSEEK_BASE_URL unset here (we inject via env) — run:
 *   node scripts/smoke-deepseek.mjs
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostBin = path.resolve(here, "../dist/bin/aether-agent-host.js");
const root = path.resolve(here, "../../..");

const dir = await mkdtemp(path.join(tmpdir(), "aether-smoke-ds-"));
let apiCalls = 0;
const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const sawToolResult = body.includes('"role":"tool"');
    apiCalls++;
    if (!sawToolResult) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "run_shell", arguments: '{"co' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mmand":"rm -rf /tmp/aether-smoke-junk"}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ choices: [{ delta: { content: "Smoke " } }] });
      send({ choices: [{ delta: { content: "OK." } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

const host = spawn(process.execPath, [hostBin], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    AETHER_DEEPSEEK_BASE_URL: apiUrl,
    AETHER_DEEPSEEK_SESSIONS_DIR: path.join(dir, "sessions"),
  },
});
const rl = readline.createInterface({ input: host.stdout });
let nextId = 1;
const pending = new Map();
const events = [];
let approvalResolve;

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    host.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  } else if (msg.method === "runtimeEvent") {
    events.push(msg.params);
  } else if (msg.method === "approvalRequested") {
    approvalResolve?.(msg.params);
  } else if (msg.method && msg.id != null) {
    // Harness-style approval request surfaced by the adapter: answer via
    // host approval/respond after the assertion below decides.
    approvalResolve?.({ __rpc: msg.id, approvalId: msg.params.approvalId });
  }
});

const waitFor = async (pred, what, ms = 20000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

let failed = false;
const ok = (cond, what) => {
  if (cond) console.log(`  ok: ${what}`);
  else {
    failed = true;
    console.error(`  FAIL: ${what}`);
  }
};

try {
  console.log("deepseek host smoke:");
  await request("host/ping");
  ok(true, "host ping");

  await request("settings/setRuntimeSecret", { runtimeId: "deepseek", secret: "smoke-key" });

  const { workspace } = await request("workspace/create", { name: "Smoke", rootPath: dir });
  const { thread } = await request("thread/create", {
    threadId: "th_smoke_ds",
    runtimeId: "deepseek",
    backendId: "deepseek-local",
    cwd: dir,
    approvalMode: "askDangerous",
  });
  ok(!!thread.externalThreadId, `thread created (${thread.externalThreadId})`);

  await request("run/start", {
    threadId: "th_smoke_ds",
    runtimeId: "deepseek",
    backendId: "deepseek-local",
    externalThreadId: thread.externalThreadId,
    runId: "run_smoke_ds",
    text: "clean junk then reply",
  });

  // Approval arrives; approve it via the host method.
  const approval = await new Promise((r) => (approvalResolve = r));
  ok(!!approval?.approvalId, `approval requested (${approval.approvalId})`);
  await request("approval/respond", { approvalId: approval.approvalId, decision: "approved_once" });

  await waitFor(() => events.some((e) => e.type === "run.completed"), "run.completed");
  const types = events.map((e) => e.type);
  ok(types.includes("run.started"), "run.started event");
  ok(types.includes("tool.started"), "tool.started event");
  ok(types.includes("command.started"), "command.started event");
  ok(types.includes("command.completed"), "command.completed event");
  ok(types.includes("approval.requested") && types.includes("approval.resolved"), "approval events");
  ok(types.includes("message.completed"), "message.completed event");
  ok(apiCalls === 2, `two api calls (tool loop then final) — got ${apiCalls}`);

  const seqs = events.map((e) => e.sequence);
  ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), "sequences strictly increasing");

  const snap = await request("thread/read", {
    threadId: "th_smoke_ds",
    runtimeId: "deepseek",
    backendId: "deepseek-local",
    externalThreadId: thread.externalThreadId,
  });
  ok(snap.items.length >= 3, `snapshot rebuilt (${snap.items.length} items)`);
} catch (err) {
  failed = true;
  console.error("  FAIL:", err.message);
} finally {
  host.kill();
  await new Promise((r) => api.close(() => r()));
  await rm(dir, { recursive: true, force: true });
}

console.log(failed ? "deepseek smoke: FAILED" : "deepseek smoke: PASSED");
process.exit(failed ? 1 : 0);
