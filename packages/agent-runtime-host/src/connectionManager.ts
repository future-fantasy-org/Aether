import type { AgentRuntimeAdapter } from "@aether/agent-contracts";
import type { RuntimeRegistry } from "./registry.js";

/**
 * Lazy per (runtimeId, backendId) adapter connections with secret injection
 * and reconnection on adapter loss.
 */
export class ConnectionManager {
  private connections = new Map<string, { adapter: AgentRuntimeAdapter }>();
  /** runtimeId -> secret (in-memory only, injected at connect). */
  private secrets = new Map<string, string>();

  constructor(private registry: RuntimeRegistry) {}

  setSecret(runtimeId: string, secret: string): void {
    this.secrets.set(runtimeId, secret);
    // Reconnect on next access so the new secret takes effect.
    for (const [key, conn] of this.connections) {
      if (key.startsWith(`${runtimeId}:`)) {
        try {
          conn.adapter.dispose();
        } catch {
          /* ignore */
        }
        this.connections.delete(key);
      }
    }
  }

  async get(runtimeId: string, backendId: string): Promise<AgentRuntimeAdapter> {
    const key = `${runtimeId}:${backendId}`;
    const existing = this.connections.get(key);
    if (existing) return existing.adapter;

    const descriptor = this.registry.get(runtimeId, backendId);
    if (!descriptor) throw new Error(`unknown runtime/backend: ${key}`);
    const adapter = descriptor.factory();
    await adapter.connect(this.secrets.get(runtimeId));
    this.connections.set(key, { adapter });
    return adapter;
  }

  isConnected(runtimeId: string, backendId: string): boolean {
    return this.connections.has(`${runtimeId}:${backendId}`);
  }

  async disconnectAll(): Promise<void> {
    for (const [, { adapter }] of this.connections) {
      try {
        await adapter.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
  }
}
