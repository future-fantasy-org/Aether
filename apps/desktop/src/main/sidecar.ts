import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  JsonRpcPeer,
  childProcessStreams,
  HOST_METHODS,
  type HostStatusKind,
} from "@aether/agent-contracts";

export interface HostSidecarOptions {
  /** Dev override: where the host bin lives. */
  hostBin?: string;
  onNotification: (kind: string, payload: unknown) => void;
  onStatus: (status: HostStatusKind) => void;
}

/** Resolve the Agent Execution Host bin (dist build of @aether/agent-runtime-host). */
function resolveHostBin(appPath: string): string {
  const candidates = [
    // Dev: monorepo layout relative to the packaged app dir.
    path.resolve(appPath, "../../packages/agent-runtime-host/dist/bin/aether-agent-host.js"),
    path.resolve(appPath, "../../../packages/agent-runtime-host/dist/bin/aether-agent-host.js"),
    // Packaged: extraResources copy of the `pnpm deploy` tree (scripts/package-prepare.mjs).
    // Default deploy puts the package at the target root; legacy layouts nest it.
    path.resolve(process.resourcesPath ?? "", "aether-agent-host/dist/bin/aether-agent-host.js"),
    path.resolve(
      process.resourcesPath ?? "",
      "aether-agent-host/node_modules/@aether/agent-runtime-host/dist/bin/aether-agent-host.js",
    ),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `aether-agent-host bin not found; build packages first (pnpm build). Tried: ${candidates.join(", ")}`,
  );
}

/**
 * Owns the Agent Execution Host sidecar process: spawn, ping handshake,
 * crash-restart with backoff, graceful shutdown (arch.md §32).
 */
export class HostSidecar {
  private cp: ChildProcess | undefined;
  private peer: JsonRpcPeer | undefined;
  private restarting = false;
  private restartDelay = 1000;
  private disposed = false;

  constructor(private opts: HostSidecarOptions, private appPath: string) {}

  get ready(): boolean {
    return !!this.peer && !!this.cp && !this.cp.killed && !this.restarting;
  }

  async start(): Promise<void> {
    this.opts.onStatus("starting");
    const hostBin = this.opts.hostBin ?? resolveHostBin(this.appPath);
    // ELECTRON_RUN_AS_NODE lets the Electron binary act as plain Node, so the
    // same code path works in dev and packaged builds.
    this.cp = spawn(process.execPath, [hostBin], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    this.peer = new JsonRpcPeer(childProcessStreams(this.cp));
    this.peer.onNotification((method, params) => this.opts.onNotification(method, params));

    this.cp.on("close", (code) => {
      if (this.disposed) return;
      this.opts.onNotification("hostStatus", { status: "stopped", code });
      void this.restart();
    });

    // Handshake ping with timeout.
    await this.withTimeout(this.peer.request(HOST_METHODS.ping), 10_000, "host ping");
    this.opts.onStatus("ready");
  }

  private async restart(): Promise<void> {
    if (this.disposed || this.restarting) return;
    this.restarting = true;
    this.opts.onStatus("restarting");
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 15_000);
    await new Promise((r) => setTimeout(r, delay));
    try {
      this.cp = undefined;
      this.peer = undefined;
      await this.start();
      this.restartDelay = 1000;
    } catch {
      // start() failed; the close handler is not attached yet, retry.
      void this.restart();
    } finally {
      this.restarting = false;
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.peer || this.restarting) {
      return Promise.reject(new Error("agent host is starting/restarting"));
    }
    return this.peer.request(method, params);
  }

  private withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
    ]);
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    if (this.peer && this.cp && !this.cp.killed) {
      try {
        await Promise.race([this.peer.request(HOST_METHODS.shutdown), new Promise((r) => setTimeout(r, 2000))]);
      } catch {
        /* ignore */
      }
    }
    this.cp?.kill();
    this.cp = undefined;
    this.peer = undefined;
  }
}
