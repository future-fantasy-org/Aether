import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Locate a detached Agent Execution Host left behind by a previous Aether
 * session (Background Run): read the session file, check the pid, and hold
 * an open socket connection to it. Returns null (and cleans stale files)
 * when no live host exists.
 */
export async function probeDetachedHost(timeoutMs = 1500): Promise<net.Socket | null> {
  const home = process.env.AETHER_HOME ?? path.join(os.homedir(), ".aether");
  const sessionFile = path.join(home, "host-session.json");

  let info: { pid?: number; socketPath?: string };
  try {
    info = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as typeof info;
  } catch {
    return null;
  }
  if (typeof info.pid !== "number" || typeof info.socketPath !== "string" || !info.socketPath) {
    return null;
  }

  if (!pidAlive(info.pid)) {
    try {
      fs.rmSync(sessionFile);
      if (process.platform !== "win32") fs.rmSync(info.socketPath, { force: true });
    } catch {
      /* best effort */
    }
    return null;
  }

  const sock = await connect(info.socketPath, timeoutMs);
  if (sock) return sock;

  // Pid alive but socket dead (host mid-exit): drop the stale session file.
  try {
    fs.rmSync(sessionFile);
  } catch {
    /* best effort */
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function connect(socketPath: string, timeoutMs: number): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      sock.removeAllListeners("connect");
      sock.removeAllListeners("error");
      if (!ok) sock.destroy();
      resolve(ok ? sock : null);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}
