import { BrowserWindow } from "electron";
import type { IpcCaller } from "../ipc/ipc.js";
import { handleIpc } from "../ipc/ipc.js";

/**
 * Each acts on the window that sent the call, never on the app window: the page a server switch
 * is replacing may call these too, and its buttons must not move the window that replaces it.
 */
export function registerWindowControls() {
  const windowFrom = (event: IpcCaller) => BrowserWindow.fromWebContents(event.sender);
  handleIpc("desktop.window.close", (event) => {
    windowFrom(event)?.close();
  });
  handleIpc("desktop.window.minimize", (event) => {
    windowFrom(event)?.minimize();
  });
  handleIpc("desktop.window.toggleMaximize", (event) => {
    const win = windowFrom(event);
    if (!win) return;
    if (win.isMaximized() || win.isFullScreen()) {
      win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
    } else {
      win.maximize();
    }
  });
  handleIpc("desktop.window.state", (event) => {
    const win = windowFrom(event);
    return {
      minimized: win?.isMinimized() ?? false,
      maximized: win?.isMaximized() ?? false,
      fullScreen: win?.isFullScreen() ?? false,
    };
  });
}
