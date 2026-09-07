import { z } from "zod";

/** What the agent runtime itself can do. */
export const RuntimeCapabilitiesSchema = z.object({
  plan: z.boolean(),
  shell: z.boolean(),
  files: z.boolean(),
  mcp: z.boolean(),
  subAgent: z.boolean(),
  approval: z.boolean(),
  steer: z.boolean(),
  fork: z.boolean(),
  interrupt: z.boolean(),
  reasoning: z.boolean(),
});
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

/** What the execution environment allows. */
export const BackendCapabilitiesSchema = z.object({
  backgroundRun: z.boolean(),
  persistentWorkspace: z.boolean(),
  remoteTerminal: z.boolean(),
  browser: z.boolean(),
  fileSync: z.boolean(),
  artifactDownload: z.boolean(),
});
export type BackendCapabilities = z.infer<typeof BackendCapabilitiesSchema>;

/** Effective = Runtime ∩ Backend. UI must key off this, never off runtimeId. */
export const effectiveCapabilities = (
  runtime: RuntimeCapabilities,
  _backend: BackendCapabilities,
): RuntimeCapabilities => ({
  plan: runtime.plan,
  shell: runtime.shell,
  files: runtime.files,
  mcp: runtime.mcp,
  subAgent: runtime.subAgent,
  approval: runtime.approval,
  steer: runtime.steer,
  fork: runtime.fork,
  interrupt: runtime.interrupt,
  reasoning: runtime.reasoning,
});
