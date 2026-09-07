#!/usr/bin/env node
/**
 * Codex runtime smoke through the real Agent Execution Host against the real
 * `codex app-server` on this machine. Skipped automatically if codex is not
 * installed.
 *
 * Usage: node scripts/smoke-codex.mjs
 */
import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const hasCodex = (() => {
  try {
    execSync("codex --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (!hasCodex) {
  console.log("codex smoke: SKIPPED (codex CLI not found)");
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const hostBin = path.resolve(here, "../dist/bin/aether-agent-host.js");
const dir = await mkdtemp(path.join(tmpdir(), "aether-smoke-cx-"));

const host = spawn(process.execPath, [hostBin], { stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: host.stdout });
let nextId = 1;
const pending = new Map();
const events = [];

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    host.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const approvalWaiters = [];
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
    approvalWaiters.forEach((w) => w(msg.params));
  }
});

const waitFor = async (pred, what, ms = 60000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
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
  console.log("codex host smoke (real codex app-server):");
  await request("host/ping");
  ok(true, "host ping");

  const { thread } = await request("thread/create", {
    threadId: "th_smoke_cx",
    runtimeId: "codex",
    backendId: "codex-local",
    cwd: dir,
  });
  ok(!!thread.externalThreadId, `thread created (${thread.externalThreadId})`);

  // Auto-approve anything codex asks (it may ask before running commands).
  approvalWaiters.push((req) => {
    void request("approval/respond", { approvalId: req.approvalId, decision: "approved_once" });
  });

  await request("run/start", {
    threadId: "th_smoke_cx",
    runtimeId: "codex",
    backendId: "codex-local",
    externalThreadId: thread.externalThreadId,
    runId: "run_smoke_cx",
    text: "Reply with exactly: AETHER_CODEX_OK and do nothing else.",
  });

  await waitFor(
    () => events.some((e) => ["run.completed", "run.failed", "run.cancelled"].includes(e.type)),
    "turn completion",
  );
  const types = events.map((e) => e.type);
  ok(types.includes("run.started"), "run.started event");

  // The OpenAI account may be quota-limited; that still proves the full
  // protocol path (turn lifecycle + error notification mapping).
  const quotaLimited = events.some(
    (e) => e.type === "error" && JSON.stringify(e.payload).toLowerCase().includes("usage limit"),
  );
  if (quotaLimited) {
    ok(types.includes("error") && types.includes("run.failed"), "usage-limit error surfaced (quota-limited account)");
    console.log("  note: codex account quota exhausted; protocol path validated, message stream not exercised");
  } else {
    ok(types.includes("run.completed"), `run.completed event (types: ${[...new Set(types)].join(",")})`);
    ok(types.includes("message.delta") || types.includes("message.completed"), "message events");
  }

  const snap = await request("thread/read", {
    threadId: "th_smoke_cx",
    runtimeId: "codex",
    backendId: "codex-local",
    externalThreadId: thread.externalThreadId,
  });
  ok(Array.isArray(snap.items), `snapshot read ok (${snap.items?.length} items)`);
} catch (err) {
  failed = true;
  console.error("  FAIL:", err.message);
} finally {
  host.kill();
  await rm(dir, { recursive: true, force: true });
}

console.log(failed ? "codex smoke: FAILED" : "codex smoke: PASSED");
process.exit(failed ? 1 : 0);
