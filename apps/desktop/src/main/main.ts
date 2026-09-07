import { app, BrowserWindow } from "electron";
import { IPC_EVENTS, type HostEventEnvelope } from "@aether/desktop-contracts";
import { createPlatformStore } from "./store.js";
import { HostSidecar } from "./sidecar.js";
import { registerIpc } from "./ipc.js";
import { createMainWindow } from "./window.js";

// Single instance lock keeps sidecar management sane.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

void (async () => {
  await app.whenReady();

  const store = await createPlatformStore(app.getPath("userData"));
  const win = createMainWindow();

  const broadcast = (envelope: HostEventEnvelope) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(IPC_EVENTS.hostEvent, envelope);
    }
  };

  const sidecar = new HostSidecar(
    {
      onNotification: (kind, payload) =>
        broadcast({ kind: kind as HostEventEnvelope["kind"], payload }),
      onStatus: (status) => broadcast({ kind: "hostStatus", payload: { status } }),
    },
    app.getAppPath(),
  );

  registerIpc({ store, sidecar, broadcast });

  await sidecar.start().catch((err: Error) => {
    broadcast({
      kind: "hostStatus",
      payload: { status: "stopped", error: err.message },
    });
  });

  app.on("before-quit", () => {
    void sidecar.shutdown();
  });
  app.on("second-instance", () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
})();
