import { app, BrowserWindow } from "electron";
import { IPC_EVENTS, type HostEventEnvelope } from "@aether/desktop-contracts";
import { createPlatformStore } from "./store.js";
import { HostSidecar } from "./sidecar.js";
import { registerIpc } from "./ipc.js";
import { createMainWindow } from "./window.js";
import { runE2E } from "./e2e.js";

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

  if (process.env.AETHER_E2E === "1") {
    // Automated end-to-end flow through the real main-process stack.
    const code = await runE2E(sidecar, store);
    app.exit(code);
    return;
  }

  app.on("before-quit", () => {
    void sidecar.shutdown();
  });
  app.on("second-instance", () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
})();
