import { existsSync } from "node:fs";
import { bestEffort } from "@rakazo/logging";
import { app, shell } from "electron";
import type { IpcCaller } from "../ipc/ipc.js";
import { handleIpc } from "../ipc/ipc.js";
import { reportDesktopError } from "../system/monitoring.js";
import { createLauncherInstaller } from "./launcher-installer.js";
import { platformLauncher, startPageApp } from "./launchers.js";
import { isLoopbackOrigin, serverOrigin, writeServerOverride } from "./page-app-files.js";
import {
  createPageAppInstaller,
  installedBundles,
  pageAppInstallRequest,
} from "./page-app-installer.js";
import { pageAppsSupported } from "./page-apps-support.js";
import type { InstalledPageApp } from "./registry.js";
import { createRegistry } from "./registry.js";

/** The server whose page made the call: apps it installed are the only ones it sees. */
function callerServer(event: IpcCaller) {
  return serverOrigin(event.senderFrame?.url);
}

/** The `pageApps` bridge, where Rakazo can make page apps. */
export function registerPageApps(userDataDir: string) {
  if (!pageAppsSupported()) return;
  // A Mac app carries its own config, so a broken registry is rebuilt from the bundles; a
  // launcher does not, so there it is refused rather than read as no apps.
  const registry = createRegistry(userDataDir, () =>
    process.platform === "darwin"
      ? installedBundles()
      : Promise.reject(new Error("The page app registry cannot be read.")),
  );
  const appData = app.getPath("appData");
  const installer =
    process.platform === "darwin"
      ? createPageAppInstaller({
          registry,
          trash: (bundle) => shell.trashItem(bundle),
          open: async (bundle) => {
            const error = await shell.openPath(bundle);
            if (error) throw new Error(error);
          },
          version: app.getVersion(),
          appData,
        })
      : createLauncherInstaller({
          registry,
          launcher: platformLauncher(appData),
          open: startPageApp,
          appData,
        });
  const open = async (entry: InstalledPageApp) => {
    if (process.platform === "darwin") return (await shell.openPath(entry.bundlePath)) === "";
    try {
      await startPageApp(entry.appId);
      return true;
    } catch (error) {
      reportDesktopError(error, "desktop.ipc", { "ipc.channel": "desktop.pageApps.open" });
      return false;
    }
  };
  /**
   * The apps the caller's server installed. Rakazo's local server can come back on another
   * port, so a local caller also takes the local apps and moves them to its port.
   */
  const appsFor = async (event: IpcCaller) => {
    const server = callerServer(event);
    if (!server) return [];
    const local = isLoopbackOrigin(server);
    const apps = (await registry.list()).filter(
      (entry) => entry.server === server || (local && isLoopbackOrigin(entry.server)),
    );
    for (const entry of apps) {
      if (entry.server === server) continue;
      await writeServerOverride(entry.appId, server, appData);
      await registry.put({ ...entry, server });
      entry.server = server;
    }
    return apps;
  };

  handleIpc("desktop.pageApps.install", async (event, input) => {
    const request = pageAppInstallRequest(input);
    const server = callerServer(event);
    if (!request || !server) return false;
    // An app another server installed is never replaced from this one.
    const installed = await registry.list();
    if (installed.some((entry) => entry.appId === request.appId && entry.server !== server))
      return false;
    try {
      return await installer.install(request, server);
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
    return open(entry);
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
