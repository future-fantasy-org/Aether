import type {
  AgentRuntimeAdapter,
  RuntimeEvent,
} from "@aether/agent-contracts";
import type {
  BackendCapabilities,
  RuntimeCapabilities,
} from "@aether/agent-domain";
import { CodexAdapter, defaultCodexCommand } from "@aether/runtime-codex";
import { DeepSeekAdapter } from "@aether/runtime-deepseek";

export interface RuntimeDescriptor {
  runtimeId: string;
  backendId: string;
  name: string;
  description: string;
  factory: () => AgentRuntimeAdapter;
  runtimeCapabilities: RuntimeCapabilities;
  backendCapabilities: BackendCapabilities;
}

export interface RegistryOptions {
  codexCommand?: { command: string; args: string[] };
  deepSeekCommand?: { command: string; args: string[] };
  deepSeekInitializeParams?: Record<string, unknown>;
}

/** Static registry of known runtime x backend combinations. */
export class RuntimeRegistry {
  private descriptors = new Map<string, RuntimeDescriptor>();

  register(d: RuntimeDescriptor): void {
    this.descriptors.set(`${d.runtimeId}:${d.backendId}`, d);
  }

  list(): RuntimeDescriptor[] {
    return [...this.descriptors.values()];
  }

  get(runtimeId: string, backendId: string): RuntimeDescriptor | undefined {
    return this.descriptors.get(`${runtimeId}:${backendId}`);
  }
}

export function defaultRegistry(opts: RegistryOptions = {}): RuntimeRegistry {
  const registry = new RuntimeRegistry();
  registry.register({
    runtimeId: "codex",
    backendId: "codex-local",
    name: "Codex",
    description: "OpenAI Codex local runtime (codex app-server)",
    factory: () => new CodexAdapter(opts.codexCommand ?? defaultCodexCommand()),
    runtimeCapabilities: {
      plan: true, shell: true, files: true, mcp: true, subAgent: true,
      approval: true, steer: true, fork: true, interrupt: true, reasoning: true,
    },
    backendCapabilities: {
      backgroundRun: false, persistentWorkspace: true, remoteTerminal: false,
      browser: false, fileSync: true, artifactDownload: false,
    },
  });
  registry.register({
    runtimeId: "deepseek",
    backendId: "deepseek-local",
    name: "DeepSeek Harness",
    description: "Built-in reference harness powered by the DeepSeek API",
    factory: () =>
      new DeepSeekAdapter({
        ...(opts.deepSeekCommand ? opts.deepSeekCommand : {}),
        ...(opts.deepSeekInitializeParams ? { initializeParams: opts.deepSeekInitializeParams } : {}),
      }),
    runtimeCapabilities: {
      plan: false, shell: true, files: true, mcp: false, subAgent: false,
      approval: true, steer: false, fork: false, interrupt: true, reasoning: true,
    },
    backendCapabilities: {
      backgroundRun: false, persistentWorkspace: true, remoteTerminal: false,
      browser: false, fileSync: true, artifactDownload: false,
    },
  });
  return registry;
}
