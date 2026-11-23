import { bestEffort } from "@rakazo/logging";
import { app, dialog } from "electron";
import { appWindowTargets, desktop } from "../desktop-state.js";
import { t } from "../i18n.js";
import type { IpcCaller, IpcHandler } from "../ipc/ipc.js";
import { sentFrom } from "../ipc/ipc.js";

/** The trust boundary: only a click on Allow here lets bots use this computer. */
async function confirmComputerAccess(detail: string) {
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    title: t("Allow local computer access?"),
    message: t("Allow bots to use this computer?"),
    detail,
    buttons: [t("Cancel"), t("Allow")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const win =
    desktop.mainWindow !== null && !desktop.mainWindow.isDestroyed() ? desktop.mainWindow : null;
  const result = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  return result.response === 1;
}

/** A bot asks while the person may be elsewhere, so bring the prompt to them. */
export function confirmRemoteComputerAccess(host: string) {
  if (desktop.mainWindow !== null && !desktop.mainWindow.isDestroyed()) {
    if (!desktop.mainWindow.isVisible()) desktop.mainWindow.show();
    else if (!desktop.mainWindow.isFocused()) app.dock?.bounce("informational");
  }
  return confirmComputerAccess(
    t(
      "Bots on {host} can run commands, read and change files, and launch apps with your account’s permissions. You can revoke access in Settings.",
      { host },
    ),
  );
}

/**
 * Whether the app window's own page, showing the app-managed local instance, asked. Asked again
 * after each wait: the window may have moved to another server meanwhile.
 */
export function isManagedComputerRequest(event: IpcCaller): boolean {
  return (
    sentFrom("app", event) &&
    desktop.currentSetup?.mode === "new" &&
    appWindowTargets.get(desktop.mainWindow!) === desktop.localStack.webUrl()
  );
}

/** The `desktop.computer.requestAccess` handler: lets bots on the app-managed instance use this computer. */
export function createComputerAccessHandler(deps: {
  persistHostChoice: () => Promise<void>;
  installApplicationMenu: () => void;
  prepareAccess: (valid: () => boolean) => Promise<void>;
}): IpcHandler<"desktop.computer.requestAccess"> {
  let requesting = false;
  const enabledFor = (event: IpcCaller) =>
    isManagedComputerRequest(event) && desktop.hostComputer?.isEnabled() === true;
  /** Access is on: set up app control in the background and report it to the page. */
  const granted = (event: IpcCaller) => {
    void bestEffort(
      "prepare local computer app control",
      deps.prepareAccess(() => enabledFor(event)),
    );
    return enabledFor(event);
  };
  return async (event) => {
    if (!isManagedComputerRequest(event) || !desktop.hostComputer)
      throw new Error(t("Local computer access requires an app-managed local instance."));
    if (requesting) return false;
    requesting = true;
    try {
      if (!(await desktop.localStack.matchesDesiredStack()) || !isManagedComputerRequest(event))
        return false;
      if (desktop.hostComputer.isEnabled()) {
        await deps.persistHostChoice();
        return granted(event);
      }
      const allowed = await confirmComputerAccess(
        t(
          "Bots on this local instance can run commands, read and change files, and launch apps with your account’s permissions. You can revoke access from the app menu.",
        ),
      );
      if (!allowed || !isManagedComputerRequest(event)) return false;
      desktop.hostComputer.activate(true);
      await desktop.hostComputer.grant();
      try {
        await deps.persistHostChoice();
      } catch (error) {
        await desktop.hostComputer.revoke();
        throw error;
      }
      deps.installApplicationMenu();
      return granted(event);
    } finally {
      requesting = false;
    }
  };
}
