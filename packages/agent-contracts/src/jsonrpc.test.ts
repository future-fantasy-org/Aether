import { describe, expect, it } from "vitest";
import { JsonRpcPeer, type PeerStreams } from "./jsonrpc.js";

/** Two in-memory peers wired back to back (synchronous delivery). */
function makePair(): [JsonRpcPeer, JsonRpcPeer] {
  let aData: ((l: string) => void) | undefined;
  let bData: ((l: string) => void) | undefined;

  const streamsA: PeerStreams = {
    write: (s) => {
      for (const line of s.split("\n")) if (line.trim()) bData?.(line);
    },
    onData: (cb) => {
      aData = cb;
    },
    onClose: () => {},
  };
  const streamsB: PeerStreams = {
    write: (s) => {
      for (const line of s.split("\n")) if (line.trim()) aData?.(line);
    },
    onData: (cb) => {
      bData = cb;
    },
    onClose: () => {},
  };
  return [new JsonRpcPeer(streamsA), new JsonRpcPeer(streamsB)];
}

/** Simulates chunked TCP-like delivery: splits one message across two chunks. */
function chunkedDelivery(): [JsonRpcPeer, (raw: string) => void] {
  let buffer = "";
  let deliver: ((line: string) => void) | undefined;
  const peer = new JsonRpcPeer({
    write: () => {},
    onData: (cb) => {
      deliver = cb;
    },
    onClose: () => {},
  });
  const feed = (raw: string) => {
    buffer += raw;
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      deliver?.(line);
    }
  };
  return [peer, feed];
}

describe("JsonRpcPeer", () => {
  it("round-trips a request/response", async () => {
    const [a, b] = makePair();
    b.onRequest(async (method, params) => {
      expect(method).toBe("add");
      expect(params).toEqual({ x: 1 });
      return 3;
    });
    await expect(a.request("add", { x: 1 })).resolves.toBe(3);
  });

  it("rejects on error response", async () => {
    const [a, b] = makePair();
    b.onRequest(async () => {
      throw new Error("boom");
    });
    await expect(a.request("fail")).rejects.toThrow("boom");
  });

  it("delivers notifications", () => {
    const [a, b] = makePair();
    const got: Array<[string, unknown]> = [];
    b.onNotification((m, p) => got.push([m, p]));
    a.notify("hello", { n: 1 });
    expect(got).toEqual([["hello", { n: 1 }]]);
  });

  it("handles server -> client requests", async () => {
    const [a, b] = makePair();
    a.onRequest(async (method) => `handled:${method}`);
    await expect(b.request("approval/request", { q: 1 })).resolves.toBe(
      "handled:approval/request",
    );
  });

  it("reassembles messages split across chunks", async () => {
    const [peer, feed] = chunkedDelivery();
    const got: string[] = [];
    peer.onNotification((m) => got.push(m));
    feed('{"jsonrpc":"2.0","me');
    feed('thod":"a","para');
    feed('ms":{}}\n');
    expect(got).toEqual(["a"]);
  });

  it("ignores malformed lines", () => {
    const [peer, feed] = chunkedDelivery();
    const got: string[] = [];
    peer.onNotification((m) => got.push(m));
    feed("this is not json\n");
    feed('{"jsonrpc":"2.0","method":"ok"}\n');
    expect(got).toEqual(["ok"]);
  });
});
