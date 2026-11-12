import type { BrowserWindow } from "electron";
import { dialog } from "electron";
import { t } from "./i18n.js";
import { reportDesktopError } from "./monitoring.js";

/** Install after initial loading; startup/server-switch failures keep their existing rollback. */
export function installRendererRecovery(win: BrowserWindow, isQuitting: () => boolean) {
  // A successful page load does not prove the renderer is stable. Keep the budget
  // for this window's lifetime, even if crashes are several minutes apart.
  const contents = win.webContents;
  const delays = [1_000, 5_000];
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let prompting = false;
  const stopped = () => isQuitting() || win.isDestroyed() || contents.isDestroyed();

  const prompt = async () => {
    if (prompting || stopped()) return;
    prompting = true;
    try {
      // A native window-modal dialog works even with no living renderer.
      const { response } = await dialog.showMessageBox(win, {
        type: "error",
        message: t("Rakazo stopped unexpectedly."),
        buttons: [t("Reload")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      prompting = false;
      if (response === 0 && !stopped()) contents.reload();
    } catch (error) {
      reportDesktopError(error, "desktop.renderer");
    } finally {
      prompting = false;
    }
  };

  const onGone = () => {
    if (stopped() || timer !== undefined || prompting) return;
    const delay = delays[attempts];
    if (delay === undefined) {
      void prompt();
      return;
    }
    attempts++;
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped()) contents.reload();
    }, delay);
  };
  contents.on("render-process-gone", onGone);
  win.once("closed", () => {
    clearTimeout(timer);
    contents.removeListener("render-process-gone", onGone);
  });
}
