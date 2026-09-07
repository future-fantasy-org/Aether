import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionStore, listSessions } from "./sessions.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aether-sess-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("round-trips events and messages with monotonic seq", async () => {
    const s1 = new SessionStore("ds_test1", dir);
    await s1.hydrate();
    const seq1 = s1.appendEvent("run.started", { runId: "r" }).seq;
    s1.appendMessage({ role: "user", content: "hi" });
    const seq2 = s1.appendEvent("message.delta", { itemId: "m", delta: "x" }).seq;
    expect(seq2).toBeGreaterThan(seq1);

    // New instance hydrates from disk (process restart simulation).
    const s2 = await SessionStore.load("ds_test1", dir);
    expect(s2.lastSequence()).toBe(s1.lastSequence());
    expect(s2.eventRecords().map((r) => r.type)).toEqual(["run.started", "message.delta"]);
    expect(s2.chatMessages()).toEqual([{ role: "user", content: "hi" }]);
    // Sequence continues monotonically across restart.
    expect(s2.nextSeq()).toBe(s1.lastSequence() + 1);
  });

  it("persists and lists session metadata", async () => {
    const s = new SessionStore("ds_test2", dir, { title: "Custom title" });
    await s.hydrate();
    await s.setTitle("Renamed");
    const all = await listSessions(dir);
    const mine = all.find((m) => m.sessionId === "ds_test2");
    expect(mine?.title).toBe("Renamed");
  });
});
