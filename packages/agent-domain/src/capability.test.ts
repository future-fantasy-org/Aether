import { describe, expect, it } from "vitest";
import { effectiveCapabilities } from "./capability.js";

const fullRuntime = {
  plan: true,
  shell: true,
  files: true,
  mcp: true,
  subAgent: true,
  approval: true,
  steer: true,
  fork: true,
  interrupt: true,
  reasoning: true,
};

describe("effectiveCapabilities", () => {
  it("returns runtime capabilities when backend allows everything", () => {
    const backend = {
      backgroundRun: true,
      persistentWorkspace: true,
      remoteTerminal: false,
      browser: false,
      fileSync: true,
      artifactDownload: true,
    };
    expect(effectiveCapabilities(fullRuntime, backend)).toEqual(fullRuntime);
  });

  it("preserves unsupported features as false", () => {
    const limited = { ...fullRuntime, steer: false, plan: false, mcp: false };
    const backend = {
      backgroundRun: false,
      persistentWorkspace: true,
      remoteTerminal: false,
      browser: false,
      fileSync: false,
      artifactDownload: false,
    };
    const eff = effectiveCapabilities(limited, backend);
    expect(eff.steer).toBe(false);
    expect(eff.plan).toBe(false);
    expect(eff.mcp).toBe(false);
    expect(eff.shell).toBe(true);
  });
});
