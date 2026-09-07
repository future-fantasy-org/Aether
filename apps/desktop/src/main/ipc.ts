import { dialog, ipcMain, Notification, shell } from "electron";
import { newId, type Thread, type Workspace } from "@aether/agent-domain";
import { HOST_METHODS } from "@aether/agent-contracts";
import { IPC, IPC_EVENTS, type AppRequestOp, type HostEventEnvelope } from "@aether/desktop-contracts";
import type { PlatformStore } from "./store.js";
import type { HostSidecar } from "./sidecar.js";

export interface IpcContext {
  store: PlatformStore;
  sidecar: HostSidecar;
  broadcast: (envelope: HostEventEnvelope) => void;
}

export function registerIpc(ctx: IpcContext): void {
  const { store, sidecar, broadcast } = ctx;

  ipcMain.handle(IPC.appRequest, async (_e, op: AppRequestOp, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    switch (op) {
      case "settings/get":
        return store.getSettings();
      case "settings/set": {
        const settings = await store.setSettings(p as never);
        // Push the deepseek key into the host (in-memory only).
        if (settings.deepseekApiKey) {
          await sidecar
            .request(HOST_METHODS.setRuntimeSecret, {
              runtimeId: "deepseek",
              secret: settings.deepseekApiKey,
            })
            .catch(() => undefined);
        }
        return settings;
      }
      case "workspaces/list": {
        const workspaces = await store.listWorkspaces();
        // Keep the host in sync so fs/terminal providers resolve roots.
        await Promise.all(
          workspaces.map((w) =>
            sidecar.request("workspace/register", { workspace: w }).catch(() => undefined),
          ),
        );
        return { workspaces };
      }
      case "workspaces/create": {
        const now = new Date().toISOString();
        const workspace: Workspace = {
          id: newId("ws"),
          name: String(p.name ?? (p.rootPath as string)?.split("/").pop() ?? "Workspace"),
          binding: { kind: "local", rootPath: String(p.rootPath ?? "") },
          settings: {},
          createdAt: now,
          updatedAt: now,
        };
        await store.upsertWorkspace(workspace);
        await sidecar.request("workspace/register", { workspace }).catch(() => undefined);
        return { workspace };
      }
      case "workspaces/delete": {
        await store.deleteWorkspace(String(p.workspaceId));
        return { ok: true };
      }
      case "threads/list": {
        const threads = await store.listThreads(p.workspaceId ? String(p.workspaceId) : undefined);
        return { threads };
      }
      case "threads/upsert": {
        const thread = p.thread as Thread;
        await store.upsertThread(thread);
        return { thread };
      }
      case "threads/delete": {
        await store.deleteThread(String(p.threadId));
        return { ok: true };
      }
      case "threads/rename": {
        const threads = await store.listThreads();
        const thread = threads.find((t) => t.id === String(p.threadId));
        if (thread) {
          await store.upsertThread({ ...thread, title: String(p.title), updatedAt: new Date().toISOString() });
        }
        return { ok: true };
      }
      case "host/push-workspaces": {
        const workspaces = await store.listWorkspaces();
        const threads = await store.listThreads();
        await Promise.all(
          workspaces.map((w) => sidecar.request("workspace/register", { workspace: w }).catch(() => undefined)),
        );
        void threads;
        return { ok: true };
      }
      case "window/pickDirectory": {
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        return { path: result.canceled ? null : result.filePaths[0] };
      }
      case "window/openPath":
        shell.openPath(String(p.path));
        return { ok: true };
      case "window/revealPath":
        shell.showItemInFolder(String(p.path));
        return { ok: true };
      case "window/notify":
        new Notification({ title: String(p.title ?? "Aether"), body: String(p.body ?? "") }).show();
        return { ok: true };
      default:
        throw new Error(`unknown app request: ${op}`);
    }
  });

  ipcMain.handle(IPC.hostRequest, (_e, op: string, payload) =>
    sidecar.request(op, payload).catch((err: Error) => {
      throw new Error(`host ${op} failed: ${err.message}`);
    }),
  );

  // Sidecar notifications are broadcast by main/index.ts via `broadcast`.
  void broadcast;
}
