import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Session file content — lets a new Electron instance find a live host. */
export interface HostSessionInfo {
  protocol: 1;
  pid: number;
  socketPath: string;
  startedAt: string;
}

export function defaultAetherHome(): string {
  return process.env.AETHER_HOME ?? path.join(os.homedir(), ".aether");
}

export function socketPathFor(aetherHome: string): string {
  // Node's net module maps this shape onto AF_UNIX sockets on POSIX and
  // named pipes on Windows transparently.
  return process.platform === "win32"
    ? "\\\\.\\pipe\\aether-host"
    : path.join(aetherHome, "host.sock");
}

export function sessionFilePath(aetherHome: string): string {
  return path.join(aetherHome, "host-session.json");
}

/** Atomic read/write of the host session file (missing/corrupt → null). */
export class SessionFile {
  constructor(private file: string) {}

  read(): HostSessionInfo | null {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const info = JSON.parse(raw) as HostSessionInfo;
      if (typeof info?.pid !== "number" || typeof info?.socketPath !== "string") return null;
      return info;
    } catch {
      return null;
    }
  }

  write(info: HostSessionInfo): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(info) + "\n");
    fs.renameSync(tmp, this.file);
  }

  remove(): void {
    try {
      fs.rmSync(this.file);
    } catch {
      /* already gone */
    }
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Probe a detached host: resolve once we can ping it over the socket. */
export function pingSocket(socketPath: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    let buffer = "";
    sock.on("connect", () => {
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "host/ping" }) + "\n");
    });
    sock.on("data", (b: Buffer) => {
      buffer += b.toString("utf8");
      if (buffer.includes("\n")) {
        clearTimeout(timer);
        try {
          const msg = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          done(!!msg?.result?.ok);
        } catch {
          done(false);
        }
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/**
 * Listen on the reconnect socket; clears stale sockets left behind by a
 * crashed host (EADDRINUSE with an unreachable peer) before giving up.
 */
export async function listenSocket(
  socketPath: string,
  onConnection: (sock: net.Socket) => void,
): Promise<net.Server> {
  const listen = () =>
    new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer(onConnection);
      server.once("error", reject);
      server.listen(socketPath, () => resolve(server));
    });

  try {
    return await listen();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") throw e;
    // Something holds the socket; only steal it when nothing answers there.
    const reachable = await pingSocket(socketPath, 500);
    if (reachable) throw new Error(`host socket in use by a live host: ${socketPath}`);
    try {
      fs.rmSync(socketPath);
    } catch {
      /* Windows named pipes cannot be unlinked; nothing to do. */
    }
    return await listen();
  }
}
