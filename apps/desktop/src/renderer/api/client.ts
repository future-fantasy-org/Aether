import { AetherRuntimeClient, type ClientBridge } from "@aether/agent-runtime-client";
import type { AppRequestOp, AetherBridge } from "@aether/desktop-contracts";

declare global {
  interface Window {
    aether?: AetherBridge;
  }
}

/** The preload bridge (throws early if the sandbox is misconfigured). */
export const bridge: AetherBridge = (() => {
  if (!window.aether) {
    throw new Error("window.aether missing — preload script did not run");
  }
  return window.aether;
})();

export const app = {
  request: (op: AppRequestOp, payload?: unknown) => bridge.appRequest(op, payload),
};

export const runtimeClient = new AetherRuntimeClient(bridge as unknown as ClientBridge);
