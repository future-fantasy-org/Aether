import { spawn, type ChildProcess } from "node:child_process";
import { JsonRpcPeer, childProcessStreams, type PeerStreams } from "@aether/agent-contracts";

export interface TransportOptions {
  command: string;
  args: string[];
}

/** Default: the `codex` CLI on PATH running its experimental app-server. */
export const defaultCodexCommand = (): TransportOptions => ({
  command: "codex",
  args: ["app-server"],
});

/**
 * Owns the `codex app-server` child process and its JSON-RPC peer.
 * The protocol is unstable; all shape handling lives in mapping.ts.
 */
export class CodexAppServerTransport {
  private cp: ChildProcess | undefined;
  private peer: JsonRpcPeer | undefined;
  private closeHandlers: Array<() => void> = [];
  private injected = false;

  constructor(private opts: TransportOptions = defaultCodexCommand()) {}

  get exited(): boolean {
    if (this.injected) return false;
    return !this.cp || this.cp.killed;
  }

  async connect(): Promise<void> {
    if (this.cp && !this.cp.killed) return;
    if (this.injected && this.peer) {
      await this.peer.request("initialize", {
        clientInfo: { name: "aether", title: "Aether", version: "0.1.0" },
        capabilities: null,
      });
      return;
    }
    this.cp = spawn(this.opts.command, this.opts.args, { stdio: ["pipe", "pipe", "inherit"] });
    this.cp.on("close", () => {
      for (const h of this.closeHandlers) h();
    });
    this.peer = new JsonRpcPeer(childProcessStreams(this.cp));
    await this.peer.request("initialize", {
      clientInfo: { name: "aether", title: "Aether", version: "0.1.0" },
      capabilities: null,
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.assertConnected();
    return this.peer!.request(method, params);
  }

  onRequest(h: (method: string, params: unknown) => Promise<unknown>): void {
    this.peer!.onRequest(h);
  }

  onNotification(h: (method: string, params: unknown) => void): void {
    this.peer!.onNotification(h);
  }

  /** Test seam: drive the transport from a script instead of a real process. */
  usePeerStreams(streams: PeerStreams): void {
    this.peer = new JsonRpcPeer(streams);
    this.injected = true;
  }

  get peerInstance(): JsonRpcPeer | undefined {
    return this.peer;
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }

  async close(): Promise<void> {
    this.cp?.kill();
    this.cp = undefined;
    this.peer = undefined;
  }

  private assertConnected(): void {
    if (!this.peer || this.exited) {
      throw new Error("codex app-server not connected (call connect() first)");
    }
  }
}
