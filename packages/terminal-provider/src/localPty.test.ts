import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPtyProvider } from "./localPty.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aether-term-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalPtyProvider", () => {
  it("creates a session, echoes a command, and disposes", async () => {
    const provider = new LocalPtyProvider();
    const session = await provider.create(dir);

    expect(provider.get(session.id)).toBeDefined();

    const output = await new Promise<string>((resolve) => {
      let acc = "";
      const timer = setTimeout(() => resolve(acc), 8000);
      session.onOutput((data) => {
        acc += data;
        if (acc.includes("AETHER_OK")) {
          clearTimeout(timer);
          resolve(acc);
        }
      });
      session.write("echo AETHER_OK\r");
    });
    expect(output).toContain("AETHER_OK");

    const exitCode = await new Promise<number>((resolve) => {
      session.onExit(resolve);
      session.dispose();
    });
    expect(exitCode).toBeGreaterThanOrEqual(0);
    expect(provider.get(session.id)).toBeUndefined();
  });
});
