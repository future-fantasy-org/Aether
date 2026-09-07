import { newId } from "@aether/agent-domain";
import type { TerminalProvider, TerminalSession } from "./types.js";

/**
 * Local PTY-backed terminal provider (arch.md §29). Runs inside the Agent
 * Execution Host (plain Node), never in the renderer.
 */
export class LocalPtyProvider implements TerminalProvider {
  private sessions = new Map<string, TerminalSession>();

  async create(cwd?: string): Promise<TerminalSession> {
    const { default: pty } = await import("node-pty");
    const id = newId("term");
    const shell = process.env.SHELL ?? "/bin/zsh";
    const ptyProc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cwd: cwd ?? process.cwd(),
      cols: 80,
      rows: 24,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });

    const outputCbs: Array<(data: string) => void> = [];
    const exitCbs: Array<(code: number) => void> = [];
    let disposed = false;

    ptyProc.onData((data: string) => {
      for (const cb of outputCbs) cb(data);
    });
    ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
      disposed = true;
      this.sessions.delete(id);
      for (const cb of exitCbs) cb(exitCode);
    });

    const session: TerminalSession = {
      id,
      write: (data) => {
        if (!disposed) ptyProc.write(data);
      },
      resize: (cols, rows) => {
        if (!disposed) ptyProc.resize(cols, rows);
      },
      dispose: () => {
        if (!disposed) ptyProc.kill();
        this.sessions.delete(id);
      },
      onOutput: (cb) => outputCbs.push(cb),
      onExit: (cb) => exitCbs.push(cb),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  dispose(id: string): void {
    this.sessions.get(id)?.dispose();
  }
}
