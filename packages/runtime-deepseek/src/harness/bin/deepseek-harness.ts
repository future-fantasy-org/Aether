#!/usr/bin/env node
// DeepSeek Harness — Aether reference agent runtime (JSON-RPC over stdio).
import { HARNESS_VERSION, HarnessServer } from "../server.js";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(HARNESS_VERSION);
  process.exit(0);
}

const server = new HarnessServer();
await server.start();
// Logs must go to stderr; stdout is the protocol channel.
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
