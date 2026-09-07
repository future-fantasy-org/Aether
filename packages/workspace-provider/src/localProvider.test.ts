import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileProvider } from "./localProvider.js";

let root: string;
let provider: LocalFileProvider;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "aether-ws-"));
  provider = new LocalFileProvider(root);
  await writeFile(path.join(root, "a.txt"), "hello aether");
  await mkdir(path.join(root, "sub"));
  await writeFile(path.join(root, "sub", "b.ts"), "export {}");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalFileProvider", () => {
  it("lists directories first then files, sorted", async () => {
    const entries = await provider.list(".");
    expect(entries.map((e) => e.name)).toEqual(["sub", "a.txt"]);
  });

  it("reads file content", async () => {
    const f = await provider.read("a.txt");
    expect(f.content).toBe("hello aether");
    expect(f.truncated).toBe(false);
  });

  it("marks truncated reads", async () => {
    const f = await provider.read("a.txt", { maxBytes: 4 });
    expect(f.content).toBe("hell");
    expect(f.truncated).toBe(true);
  });

  it("writes and reads back nested paths", async () => {
    await provider.write("nested/deep/c.txt", "nested!");
    const f = await provider.read("nested/deep/c.txt");
    expect(f.content).toBe("nested!");
  });

  it("stats files", async () => {
    const s = await provider.stat("a.txt");
    expect(s.kind).toBe("file");
    expect(s.size).toBeGreaterThan(0);
  });

  it("rejects paths escaping the root", async () => {
    await expect(provider.read("../../etc/passwd")).rejects.toThrow(/escapes workspace root/);
    await expect(provider.list("..")).rejects.toThrow(/escapes workspace root/);
  });
});
