import { contextBridge, ipcRenderer } from "electron";
import { IPC, IPC_EVENTS } from "@aether/desktop-contracts";

contextBridge.exposeInMainWorld("aether", {
  appRequest: (op: string, payload?: unknown) => ipcRenderer.invoke(IPC.appRequest, op, payload),
  hostRequest: (op: string, payload?: unknown) => ipcRenderer.invoke(IPC.hostRequest, op, payload),
  onHostEvent: (cb: (envelope: { kind: string; payload: unknown }) => void) => {
    const listener = (_e: unknown, envelope: { kind: string; payload: unknown }) => cb(envelope);
    ipcRenderer.on(IPC_EVENTS.hostEvent, listener);
    return () => ipcRenderer.removeListener(IPC_EVENTS.hostEvent, listener);
  },
});
