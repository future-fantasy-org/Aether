#!/usr/bin/env node
// Aether Agent Execution Host — sidecar process spawned by Electron Main.
// Serves stdio (bootstrap channel) plus a reconnect socket, and keeps running
// without a client while runs are in flight (Detached Run, arch.md §16).
import { AetherHost } from "../host.js";

const host = new AetherHost();
void host.start().then(
  () => process.stderr.write("[aether-agent-host] ready\n"),
  (err) => {
    process.stderr.write(`[aether-agent-host] failed to start: ${err}\n`);
    process.exit(1);
  },
);
process.on("SIGTERM", () => {
  void host.stop().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void host.stop().finally(() => process.exit(0));
});
