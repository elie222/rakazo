import { existsSync } from "node:fs";
import { bestEffort } from "@rakazo/logging";
import { app, shell } from "electron";
import { desktop } from "../desktop-state.js";
import type { IpcCaller } from "../ipc/ipc.js";
import { handleIpc } from "../ipc/ipc.js";
import { serverHeadersFor } from "../setup/setup-config.js";
import { reportDesktopError } from "../system/monitoring.js";
import { isLoopbackOrigin, serverOrigin, writeServerOverride } from "./page-app-files.js";
import {
  createPageAppInstaller,
  installedBundles,
  pageAppInstallRequest,
} from "./page-app-installer.js";
import { pageAppsSupported } from "./page-apps-support.js";
import { createRegistry } from "./registry.js";

/** The origin of the local server Rakazo itself runs, while the app is set up to use it. */
function managedLocalServer(): string | null {
  return desktop.currentSetup?.mode === "new" ? serverOrigin(desktop.localStack.webUrl()) : null;
}

/** The server whose page made the call: apps it installed are the only ones it sees. */
function callerServer(event: IpcCaller) {
  return serverOrigin(event.senderFrame?.url);
}

/** The `pageApps` bridge, where Rakazo can make page apps. */
export function registerPageApps(userDataDir: string) {
  if (!pageAppsSupported()) return;
  const registry = createRegistry(userDataDir, () => installedBundles());
  const installer = createPageAppInstaller({
    registry,
    trash: (bundle) => shell.trashItem(bundle),
    open: async (bundle) => {
      const error = await shell.openPath(bundle);
      if (error) throw new Error(error);
    },
    version: app.getVersion(),
  });
  /**
   * The apps the caller's server installed. Rakazo's own local server can come back on another
   * port, so while the window shows it, it also takes the local apps and moves them to its port;
   * any other server on this computer only ever sees the apps it installed.
   */
  const appsFor = async (event: IpcCaller) => {
    const server = callerServer(event);
    if (!server) return [];
    const local = server === managedLocalServer();
    const apps = (await registry.list()).filter(
      (entry) => entry.server === server || (local && isLoopbackOrigin(entry.server)),
    );
    for (const entry of apps) {
      if (entry.server === server) continue;
      await writeServerOverride(entry.appId, server);
      await registry.put({ ...entry, server });
      entry.server = server;
    }
    return apps;
  };

  handleIpc("desktop.pageApps.install", async (event, input) => {
    const request = pageAppInstallRequest(input);
    const server = callerServer(event);
    if (!request || !server) return false;
    try {
      return await installer.install(
        request,
        server,
        serverHeadersFor(server, desktop.currentSetup),
      );
    } catch (error) {
      reportDesktopError(error, "desktop.ipc", { "ipc.channel": "desktop.pageApps.install" });
      return false;
    }
  });
  handleIpc("desktop.pageApps.installed", async (event) =>
    (await appsFor(event))
      .filter((entry) => existsSync(entry.bundlePath))
      .map(({ appId, pageId, title }) => ({ appId, pageId, title })),
  );
  handleIpc("desktop.pageApps.open", async (event, appId) => {
    // An update moves the bundle for a moment; opening waits until it is back in place.
    await installer.idle();
    const entry = (await appsFor(event)).find((candidate) => candidate.appId === appId);
    if (!entry || !existsSync(entry.bundlePath)) return false;
    return (await shell.openPath(entry.bundlePath)) === "";
  });
  handleIpc("desktop.pageApps.uninstall", async (event, appId) => {
    const entry = (await appsFor(event)).find((candidate) => candidate.appId === appId);
    if (!entry) return false;
    try {
      return await installer.uninstall(entry.appId);
    } catch (error) {
      reportDesktopError(error, "desktop.ipc", { "ipc.channel": "desktop.pageApps.uninstall" });
      return false;
    }
  });
  void bestEffort("refresh page apps", installer.refresh());
}
