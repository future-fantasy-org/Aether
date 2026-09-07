#!/usr/bin/env node
/**
 * Desktop E2E runner: launches the real Electron app in AETHER_E2E mode with
 * a fake DeepSeek API server and a scratch workspace, and reports the result.
 *
 * Usage: node e2e/run-e2e.mjs
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const root = path.resolve(appDir, "../..");
const electronBin = path.join(root, "node_modules", ".bin", "electron");

const dir = await mkdtemp(path.join(tmpdir(), "aether-e2e-"));
await writeFile(path.join(dir, "hello.txt"), "hello from e2e");

const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (!body.includes('"role":"tool"')) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "run_shell", arguments: '{"co' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mmand":"rm -rf /tmp/aether-e2e-junk"}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ choices: [{ delta: { content: "E2E agent done." } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

const cp = spawn(electronBin, ["."], {
  cwd: appDir,
  env: {
    ...process.env,
    AETHER_E2E: "1",
    AETHER_E2E_WORKSPACE: dir,
    AETHER_DEEPSEEK_BASE_URL: apiUrl,
    AETHER_DEEPSEEK_SESSIONS_DIR: path.join(dir, "sessions"),
    ELECTRON_ENABLE_LOGGING: "0",
  },
  stdio: ["ignore", "pipe", "inherit"],
});

let failed = true;
const rl = readline.createInterface({ input: cp.stdout });
rl.on("line", (line) => {
  if (line.startsWith("E2E ")) {
    console.log(line);
    if (line.includes("E2E PASSED")) failed = false;
  }
});

const timeout = setTimeout(() => {
  console.error("E2E runner: timed out");
  cp.kill(9);
}, 90000);

const code = await new Promise((resolve) => cp.on("exit", resolve));
clearTimeout(timeout);
await new Promise((r) => api.close(() => r()));
await rm(dir, { recursive: true, force: true });

console.log(failed || code !== 0 ? `E2E runner: FAILED (exit ${code})` : "E2E runner: PASSED");
process.exit(failed || code !== 0 ? 1 : 0);
