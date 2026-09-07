#!/usr/bin/env node
// Aether Agent Execution Host — sidecar process owned by Electron Main.
import { AetherHost } from "../host.js";

const host = new AetherHost();
host.start();
process.stderr.write("[aether-agent-host] ready\n");
process.on("SIGTERM", () => {
  void host.stop().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void host.stop().finally(() => process.exit(0));
});
