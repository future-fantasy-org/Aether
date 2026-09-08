import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  JsonRpcPeer,
  childProcessStreams,
  socketStreams,
  HOST_METHODS,
  type HostStatusKind,
} from "@aether/agent-contracts";
import { probeDetachedHost } from "./hostProbe.js";

export interface HostSidecarOptions {
  /** Dev override: where the host bin lives. */
  hostBin?: string;
  /** Orphan-mode approval timeout in ms; <= 0 disables. Default from settings. */
  approvalTimeoutMs?: number;
  onNotification: (kind: string, payload: unknown) => void;
  onStatus: (status: HostStatusKind, error?: string) => void;
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
 * Owns the connection to the Agent Execution Host (arch.md §32).
 *
 * Two connection modes:
 *  - "socket" — reconnected to a detached host that outlived the previous
 *    Aether session (Background Run, arch.md §16);
 *  - "stdio"  — freshly spawned sidecar.
 *
 * The host itself decides whether to outlive this process: when Main skips
 * shutdown() with active runs, the stdio EOF on our exit detaches the host
 * into orphan mode.
 */
export class HostSidecar {
  private cp: ChildProcess | undefined;
  private peer: JsonRpcPeer | undefined;
  private mode: "stdio" | "socket" | undefined;
  private restarting = false;
  private restartDelay = 1000;
  private disposed = false;

  constructor(
    private opts: HostSidecarOptions,
    private appPath: string,
  ) {}

  get ready(): boolean {
    return !!this.peer && !this.restarting;
  }

  async start(): Promise<void> {
    this.opts.onStatus("starting");

    // Reuse a detached host from a previous session if one is alive.
    const sock = await probeDetachedHost();
    if (sock) {
      this.mode = "socket";
      this.cp = undefined;
      this.attachPeer(sock);
      try {
        await this.withTimeout(this.peer!.request(HOST_METHODS.ping), 10_000, "host ping");
      } catch (err) {
        // Probe raced with the host exiting; fall through to a fresh spawn.
        sock.destroy();
        this.peer = undefined;
        throw err;
      }
      this.opts.onStatus("reconnected");
      return;
    }

    await this.spawnFresh();
    this.opts.onStatus("ready");
  }

  private async spawnFresh(): Promise<void> {
    const hostBin = this.opts.hostBin ?? resolveHostBin(this.appPath);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // ELECTRON_RUN_AS_NODE lets the Electron binary act as plain Node, so
      // the same code path works in dev and packaged builds.
      ELECTRON_RUN_AS_NODE: "1",
    };
    if (this.opts.approvalTimeoutMs !== undefined) {
      env.AETHER_APPROVAL_TIMEOUT_MS = String(this.opts.approvalTimeoutMs);
    }
    this.mode = "stdio";
    // detached: the host may need to outlive this process (Background Run).
    this.cp = spawn(process.execPath, [hostBin], {
      stdio: ["pipe", "pipe", "inherit"],
      env,
      detached: true,
    });
    this.attachPeer(this.cp);

    this.cp.on("close", (code) => {
      if (this.disposed || this.mode !== "stdio") return;
      this.opts.onNotification("hostStatus", { status: "stopped", code });
      void this.restart();
    });

    // Handshake ping with timeout.
    await this.withTimeout(this.peer!.request(HOST_METHODS.ping), 10_000, "host ping");
  }

  /** Wire a new transport (child process or socket) as the active peer. */
  private attachPeer(transport: ChildProcess | net.Socket): void {
    this.peer =
      transport instanceof net.Socket
        ? new JsonRpcPeer(socketStreams(transport))
        : new JsonRpcPeer(childProcessStreams(transport));
    this.peer.onNotification((method, params) => this.opts.onNotification(method, params));
    if (transport instanceof net.Socket) {
      transport.on("close", () => {
        if (this.disposed || this.mode !== "socket") return;
        void this.restart();
      });
    }
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

  /** True when the host reports in-flight runs (Background Run keep-alive). */
  async hasActiveRuns(): Promise<boolean> {
    try {
      const st = (await this.request(HOST_METHODS.hostStatus)) as { activeRuns?: number };
      return (st?.activeRuns ?? 0) > 0;
    } catch {
      return false;
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
    ]);
  }

  /**
   * Graceful stop. Main must only call this when no runs are active;
   * otherwise skip it and let the host detach (arch.md §16).
   */
  async shutdown(): Promise<void> {
    this.disposed = true;
    if (this.peer) {
      try {
        await Promise.race([
          this.peer.request(HOST_METHODS.shutdown),
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch {
        /* ignore */
      }
    }
    // Detached children need an explicit negative-pid signal to die.
    if (this.cp?.pid && this.mode === "stdio") {
      try {
        process.kill(-this.cp.pid, "SIGTERM");
      } catch {
        this.cp.kill("SIGTERM");
      }
    }
    this.cp = undefined;
    this.peer = undefined;
  }
}
