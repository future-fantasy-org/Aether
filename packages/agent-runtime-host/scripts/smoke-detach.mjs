#!/usr/bin/env node
/**
 * Detached Run (Background Run, arch.md §16) smoke through the real host:
 *
 *   stdio client starts a run → stdio closes (simulated app quit) →
 *   host keeps running (orphan) → orphan approval times out and is
 *   auto-rejected → run completes → socket client reconnects, replays the
 *   thread, observes completion → host idles out and exits.
 *
 * Run: node scripts/smoke-detach.mjs
 */
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostBin = path.resolve(here, "../dist/bin/aether-agent-host.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`smoke-detach: FAIL — ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

const dir = await mkdtemp(path.join(tmpdir(), "aether-smoke-detach-"));

// Fake DeepSeek API: first round asks for a dangerous shell command (spawns
// an approval), then a slow streamed answer that is still running when the
// client detaches.
const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (!body.includes('"role":"tool"')) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "run_shell", arguments: '{"co' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mmand":"rm -rf /tmp/aether-detach-junk"}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      for (const chunk of ["Background ", "run ", "kept ", "working ", "while ", "detached. "]) {
        send({ choices: [{ delta: { content: chunk } }] });
        await sleep(350);
      }
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

console.log("smoke-detach: spawning host with stdio client…");
const host = spawn(process.execPath, [hostBin], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    AETHER_HOME: dir,
    AETHER_DEEPSEEK_BASE_URL: apiUrl,
    AETHER_DEEPSEEK_SESSIONS_DIR: path.join(dir, "sessions"),
    AETHER_APPROVAL_TIMEOUT_MS: "1200",
  },
});
const pid = host.pid;

const kill = () => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
};
const alive = () => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
setTimeout(() => {
  kill();
  fail("global timeout");
  process.exit(process.exitCode ?? 1);
}, 60_000).unref();

let nextId = 1;
const pending = new Map();
let notify = () => {};
const wire = (input, output) => {
  const rl = readline.createInterface({ input });
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
    } else if (msg.method) {
      notify(msg);
    }
  });
  return (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      output.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
};

const stdioCall = wire(host.stdout, host.stdin);

// --- Phase 1: stdio session starts a run that will block on an approval.
await stdioCall("host/ping");
await stdioCall("settings/setRuntimeSecret", { runtimeId: "deepseek", secret: "smoke-key" });
const { thread } = await stdioCall("thread/create", {
  runtimeId: "deepseek",
  backendId: "deepseek-local",
  cwd: dir,
  approvalMode: "askDangerous",
});
await stdioCall("run/start", {
  threadId: thread.id,
  runtimeId: "deepseek",
  backendId: "deepseek-local",
  externalThreadId: thread.externalThreadId,
  text: "please run the cleanup command",
});
ok(`run started (thread ${thread.id})`);

await sleep(600); // approval.requested arrives while the client is attached

// --- Phase 2: the Electron "process" goes away — stdio EOF detaches the host.
host.stdin.destroy();
await sleep(900);
if (!alive()) {
  kill();
  fail("host died after stdio detach despite an active run");
  process.exit(1);
}
ok("host survived stdio detach (orphan mode)");

const rawSession = await readFile(path.join(dir, "host-session.json"), "utf8");
const session = JSON.parse(rawSession);
if (session.pid !== pid || !session.socketPath) {
  kill();
  fail(`bad session file: ${rawSession}`);
  process.exit(1);
}
ok(`session file intact (socket ${session.socketPath})`);

// --- Phase 3: reconnect over the socket while the run is still going.
await sleep(700); // mid-run (the slow streamed answer spans several seconds)
const sock = net.connect(session.socketPath);
await new Promise((resolve, reject) => {
  sock.once("connect", resolve);
  sock.once("error", reject);
});
const socketEvents = [];
notify = (msg) => socketEvents.push(msg);
const socketCall = wire(sock, sock);
const pong = await socketCall("host/ping");
if (!pong?.ok) {
  kill();
  fail("socket ping failed after reconnect");
  process.exit(1);
}
ok("reconnected over socket and pinged");

// --- Phase 4: wait for the run to finish (approval was auto-rejected by the
// orphan timeout, then the model streamed its final answer).
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const st = await socketCall("host/status");
  if (st.activeRuns === 0) break;
  await sleep(250);
}
const finalStatus = await socketCall("host/status");
if (finalStatus.activeRuns !== 0) {
  kill();
  fail(`run never finished (activeRuns=${finalStatus.activeRuns})`);
  process.exit(1);
}
ok("run reached a terminal state after orphan approval timeout + reconnect");

const snap = await socketCall("thread/read", {
  threadId: thread.id,
  runtimeId: "deepseek",
  backendId: "deepseek-local",
  externalThreadId: thread.externalThreadId,
});
const kinds = new Set((snap.items ?? []).map((i) => i.type));
if (!kinds.has("agent_message")) {
  kill();
  fail(`thread replay missing final message; kinds=[${[...kinds].join(",")}]`);
  process.exit(1);
}
ok(`thread replay ok (${(snap.items ?? []).length} items, includes final message)`);

// --- Phase 5: idle orphan exits by itself.
sock.destroy();
const exitDeadline = Date.now() + 15_000;
while (alive() && Date.now() < exitDeadline) await sleep(300);
if (alive()) {
  kill();
  fail("idle orphan host did not exit");
  process.exit(1);
}
ok("idle orphan host exited on its own");

api.close();
await rm(dir, { recursive: true, force: true });
console.log("smoke-detach: PASSED");
