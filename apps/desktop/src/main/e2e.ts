import type { PlatformStore } from "./store.js";
import type { HostSidecar } from "./sidecar.js";
import { HOST_METHODS } from "@aether/agent-contracts";

/**
 * Main-process end-to-end flow (AETHER_E2E=1): drives the real stack —
 * Electron main -> host sidecar -> DeepSeekAdapter -> harness -> (fake) API —
 * and asserts the full event round trip including approval. Exits the app
 * with code 0/1 and prints E2E lines to stdout for the runner script.
 */
export async function runE2E(sidecar: HostSidecar, store: PlatformStore): Promise<number> {
  const log = (msg: string) => process.stdout.write(`E2E ${msg}\n`);
  let failed = false;
  const ok = (cond: boolean, what: string) => {
    if (cond) log(`ok: ${what}`);
    else {
      failed = true;
      log(`FAIL: ${what}`);
    }
  };

  const events: Array<{ type: string; payload: unknown; threadId: string }> = [];
  const approvals: Array<{ approvalId: string }> = [];
  sidecarBridge(sidecar, (kind, payload) => {
    if (kind === "runtimeEvent") {
      const ev = payload as { type: string; payload: unknown; threadId: string };
      events.push(ev);
    }
    if (kind === "approvalRequested") approvals.push(payload as { approvalId: string });
  });

  try {
    log("start (deepseek runtime, fake API via AETHER_DEEPSEEK_BASE_URL)");
    ok(sidecar.ready, "sidecar ready");

    // Settings flow through the store (same code path the settings UI uses).
    await store.setSettings({ deepseekApiKey: "e2e-key" });
    await sidecar.request(HOST_METHODS.setRuntimeSecret, { runtimeId: "deepseek", secret: "e2e-key" });

    // Workspace + thread via host (same methods the renderer calls).
    const { workspace } = (await sidecar.request(HOST_METHODS.createWorkspace, {
      name: "E2E",
      rootPath: process.env.AETHER_E2E_WORKSPACE,
    })) as { workspace: { id: string } };
    ok(true, `workspace created (${workspace.id})`);

    const { thread } = (await sidecar.request(HOST_METHODS.createThread, {
      threadId: "th_e2e",
      runtimeId: "deepseek",
      backendId: "deepseek-local",
      cwd: process.env.AETHER_E2E_WORKSPACE,
      approvalMode: "askDangerous",
    })) as { thread: { id: string; externalThreadId: string } };
    ok(true, `thread created (${thread.externalThreadId})`);

    // Persist thread metadata like the sidebar does (renderer parity).
    await store.upsertThread({
      id: thread.id,
      workspaceId: workspace.id,
      title: "E2E flow",
      runtimeBinding: {
        runtimeId: "deepseek",
        backendId: "deepseek-local",
        externalThreadId: thread.externalThreadId,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archived: false,
    });
    const threads = await store.listThreads(workspace.id);
    ok(threads.length === 1 && threads[0].runtimeBinding?.externalThreadId === thread.externalThreadId, "thread mapping persisted");

    await sidecar.request(HOST_METHODS.startRun, {
      threadId: thread.id,
      runtimeId: "deepseek",
      backendId: "deepseek-local",
      externalThreadId: thread.externalThreadId,
      runId: "run_e2e",
      text: "run the smoke command then finish",
    });

    // Approval round trip.
    const deadline = Date.now() + 20000;
    while (approvals.length === 0 && Date.now() < deadline) {
      await sleep(50);
    }
    ok(approvals.length > 0, "approval surfaced to main");
    if (approvals[0]) {
      await sidecar.request(HOST_METHODS.respondApproval, {
        approvalId: approvals[0].approvalId,
        decision: "approved_once",
      });
      ok(true, "approval decision routed");
    }

    // Wait for completion.
    const done = Date.now() + 20000;
    while (!events.some((e) => e.type === "run.completed") && Date.now() < done) {
      await sleep(50);
    }
    const types = events.map((e) => e.type);
    ok(types.includes("run.started"), "run.started");
    ok(types.includes("tool.started"), "tool.started");
    ok(types.includes("command.started"), "command.started");
    ok(types.includes("command.completed"), "command.completed");
    ok(types.includes("approval.requested") && types.includes("approval.resolved"), "approval events");
    ok(types.includes("message.completed"), "message.completed");
    ok(types.includes("run.completed"), "run.completed");

    // Terminal + fs + artifact providers through the same host.
    const { terminalId } = (await sidecar.request(HOST_METHODS.terminalCreate, {
      workspaceId: workspace.id,
    })) as { terminalId: string };
    ok(!!terminalId, `terminal created (${terminalId})`);
    await sidecar.request(HOST_METHODS.terminalWrite, { terminalId, data: "echo E2E_TERM_OK\r" });
    await sleep(1500);
    await sidecar.request(HOST_METHODS.terminalDispose, { terminalId });

    const { artifact } = (await sidecar.request(HOST_METHODS.artifactSave, {
      threadId: thread.id,
      title: "e2e.md",
      type: "markdown",
      content: "# e2e",
    })) as { artifact: { id: string } };
    const arts = (await sidecar.request(HOST_METHODS.artifactList, {
      threadId: thread.id,
    })) as { artifacts: Array<{ id: string }> };
    ok(arts.artifacts.some((a) => a.id === artifact.id), "artifact saved & listed");

    const listRes = (await sidecar.request(HOST_METHODS.fsList, {
      workspaceId: workspace.id,
      path: ".",
    })) as { entries: Array<{ name: string }> };
    ok(listRes.entries.some((e) => e.name === "hello.txt"), "fs list sees workspace file");
  } catch (err) {
    failed = true;
    log(`FAIL: unexpected error: ${(err as Error).message}`);
  }

  log(failed ? "E2E FAILED" : "E2E PASSED");
  await sidecar.shutdown();
  return failed ? 1 : 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Attach an extra notification listener to the sidecar for assertions. */
function sidecarBridge(sidecar: HostSidecar, cb: (kind: string, payload: unknown) => void): void {
  const internal = sidecar as unknown as { opts: HostSidecar["opts"] };
  const original = internal.opts.onNotification;
  internal.opts.onNotification = (kind: string, payload: unknown) => {
    cb(kind, payload);
    original(kind, payload);
  };
}
