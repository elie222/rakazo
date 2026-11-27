import { existsSync } from "node:fs";
import { bestEffort } from "@rakazo/logging";
import { app, shell } from "electron";
import type { IpcCaller } from "../ipc/ipc.js";
import { handleIpc } from "../ipc/ipc.js";
import { reportDesktopError } from "../system/monitoring.js";
import { serverOrigin } from "./page-app-files.js";
import { createPageAppInstaller, pageAppInstallRequest } from "./page-app-installer.js";
import { pageAppsSupported } from "./page-apps-support.js";
import { createRegistry } from "./registry.js";

/** The server whose page made the call: apps it installed are the only ones it sees. */
function callerServer(event: IpcCaller) {
  return serverOrigin(event.senderFrame?.url);
}

/** The `pageApps` bridge, where Rakazo can make page apps. */
export function registerPageApps(userDataDir: string) {
  if (!pageAppsSupported()) return;
  const registry = createRegistry(userDataDir);
  const installer = createPageAppInstaller({
    registry,
    trash: (bundle) => shell.trashItem(bundle),
    open: async (bundle) => {
      const error = await shell.openPath(bundle);
      if (error) throw new Error(error);
    },
    version: app.getVersion(),
  });
  const appsFor = async (event: IpcCaller) => {
    const server = callerServer(event);
    return (await registry.list()).filter((entry) => entry.server === server);
  };

  handleIpc("desktop.pageApps.install", async (event, input) => {
    const request = pageAppInstallRequest(input);
    const server = callerServer(event);
    if (!request || !server) return false;
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
