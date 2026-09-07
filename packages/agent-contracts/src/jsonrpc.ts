export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface PeerStreams {
  write(data: string): void;
  onData(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
}

/**
 * Minimal JSON-RPC 2.0 peer over line-delimited (JSONL) byte streams.
 * Used by: host (stdin/stdout), harness (stdin/stdout), transports (child stdio).
 */
export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private requestHandler?: (method: string, params: unknown) => Promise<unknown>;
  private notificationHandler?: (method: string, params: unknown) => void;
  private closeHandler?: () => void;

  constructor(private streams: PeerStreams) {
    this.streams.onData((line) => this.handleLine(line));
    this.streams.onClose(() => this.closeHandler?.());
  }

  onRequest(h: (method: string, params: unknown) => Promise<unknown>): void {
    this.requestHandler = h;
  }

  onNotification(h: (method: string, params: unknown) => void): void {
    this.notificationHandler = h;
  }

  onClose(cb: () => void): void {
    this.closeHandler = cb;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private send(msg: JsonRpcMessage): void {
    this.streams.write(JSON.stringify(msg) + "\n");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // ignore malformed lines
    }
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      // server -> client request
      this.requestHandler
        ?.(msg.method, msg.params)
        .then((r) => this.respond(msg.id!, r))
        .catch((e: unknown) =>
          this.respondError(msg.id!, -32000, String((e as Error)?.message ?? e)),
        );
    } else if (msg.method) {
      this.notificationHandler?.(msg.method, msg.params);
    } else if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    }
  }
}

/** Adapt a Node child process (or process itself) to PeerStreams. */
export function childProcessStreams(cp: {
  stdin: { write(...data: unknown[]): unknown } | null;
  stdout: { on(ev: "data", cb: (b: Buffer) => void): unknown } | null;
  on(ev: "close", cb: () => void): unknown;
}): PeerStreams {
  let buffer = "";
  const stdout = cp.stdout;
  return {
    write: (s) => {
      cp.stdin?.write(s);
    },
    onData: (cb) => {
      stdout?.on("data", (b: Buffer) => {
        buffer += b.toString("utf8");
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          cb(line);
        }
      });
    },
    onClose: (cb) => {
      cp.on("close", cb);
    },
  };
}

/**
 * Adapt the *current* process stdio to PeerStreams (for a server speaking
 * JSON-RPC over its own stdin/stdout, e.g. the harness and the host).
 */
export function selfProcessStreams(proc: {
  stdin: NodeJS.ReadableStream & { read?: () => unknown };
  stdout: NodeJS.WritableStream;
  once?(ev: string, cb: () => void): unknown;
  on?(ev: string, cb: () => void): unknown;
}): PeerStreams {
  let buffer = "";
  return {
    write: (s) => {
      proc.stdout.write(s);
    },
    onData: (cb) => {
      proc.stdin.on("data", (b: Buffer) => {
        buffer += b.toString("utf8");
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          cb(line);
        }
      });
      proc.stdin.resume?.();
    },
    onClose: (cb) => {
      proc.stdin.on?.("end", cb);
      proc.stdin.on?.("close", cb);
    },
  };
}
