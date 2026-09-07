import { describe, expect, it } from "vitest";
import { canTransition, isTerminalRunStatus } from "./run.js";

describe("run state machine", () => {
  it("allows RUNNING -> WAITING_APPROVAL", () => {
    expect(canTransition("RUNNING", "WAITING_APPROVAL")).toBe(true);
  });
  it("allows RUNNING -> WAITING_TOOL and back", () => {
    expect(canTransition("RUNNING", "WAITING_TOOL")).toBe(true);
    expect(canTransition("WAITING_TOOL", "RUNNING")).toBe(true);
  });
  it("rejects COMPLETED -> RUNNING", () => {
    expect(canTransition("COMPLETED", "RUNNING")).toBe(false);
  });
  it("allows self transition", () => {
    expect(canTransition("RUNNING", "RUNNING")).toBe(true);
  });
  it("recognizes terminal states", () => {
    expect(isTerminalRunStatus("COMPLETED")).toBe(true);
    expect(isTerminalRunStatus("DISCONNECTED")).toBe(true);
    expect(isTerminalRunStatus("RUNNING")).toBe(false);
  });
});
