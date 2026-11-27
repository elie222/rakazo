import { readFileSync } from "node:fs";
import path from "node:path";
import type { PageAbility } from "@rakazo/contracts";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { BrowserWindow, MessageBoxOptions } from "electron";
import { app, clipboard, dialog, Notification, nativeTheme, shell } from "electron";
import { desktop } from "./desktop-state.js";
import { startDesktopLocale, t } from "./i18n.js";
import { handleIpc } from "./ipc/ipc.js";
import { createPageAppController } from "./page-apps/app/page-app-controller.js";
import {
  createPageAppWindow,
  pageAppMenu,
  registerPageAppScheme,
  servePageApp,
  setPageAppMenu,
} from "./page-apps/app/page-app-window.js";
import { runningBundle } from "./page-apps/bundle-builder.js";
import { createPageAppApi, revokePageAppToken } from "./page-apps/page-app-api.js";
import {
  PAGE_APP_CONFIG_FILE,
  pageAppConfig,
  pageAppDataDir,
  readPageAppToken,
  readServerOverride,
  removePageAppData,
} from "./page-apps/page-app-files.js";
import { systemWindowBackground } from "./windows/window-options.js";

const config = pageAppConfig(
  JSON.parse(readFileSync(path.join(process.resourcesPath, PAGE_APP_CONFIG_FILE), "utf8")),
);
if (!config) throw new Error("This page app's config is not usable.");
const { appId, pageId, title } = config;
const server = readServerOverride(appId) ?? config.server;

app.setName(title);
app.setPath("userData", pageAppDataDir(appId));
registerPageAppScheme();

/**
 * Moves this app to the Trash. Its data goes only with a revoked token; otherwise Rakazo finds
 * the app in the Trash on its next start and revokes the token from there.
 */
async function removeSelf(revoked: boolean) {
  // A bundle the Trash refused stays usable: its data goes only once the bundle is gone.
  const trashed = await shell.trashItem(runningBundle()).then(
    () => true,
    (error: unknown) => {
      getLogger().warn("page app could not move itself to the Trash", { error });
      return false;
    },
  );
  if (revoked && trashed) await bestEffort("remove page app data", removePageAppData(appId));
  app.exit(0);
}

async function start() {
  startDesktopLocale(null, app.getPreferredSystemLanguages()[0] ?? app.getLocale());
  const token = await readPageAppToken(appId);
  const api = createPageAppApi(server, token ?? "", fetch);
  const notifications = new Set<Notification>();
  let removing = false;

  let win: BrowserWindow | null = null;
  const openWindow = () => (win && !win.isDestroyed() ? win : undefined);

  const removed = async () => {
    if (removing) return;
    removing = true;
    const { response } = await showDialog({
      message: t("{name} was removed.", { name: title }),
      buttons: [t("Move to Trash"), t("Quit")],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) await removeSelf(true);
    else app.exit(0);
  };

  const controller = createPageAppController(api, {
    name: title,
    theme: () => (nativeTheme.shouldUseDarkColors ? "dark" : "light"),
    surface: () => systemWindowBackground(nativeTheme.shouldUseDarkColors),
    show: (screen) => openWindow()?.webContents.send("desktop.pageApp.screen", screen),
    confirmAbility: async (ability: PageAbility) => {
      const { response } = await showDialog({
        message:
          ability === "ask"
            ? t("Allow {name} to ask its bot?", { name: title })
            : t("Allow {name} to show notifications?", { name: title }),
        buttons: [t("Allow"), t("Not Now")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      return response === 0;
    },
    notify: (heading, body) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: heading, body });
      notifications.add(notification);
      notification.on("click", () => {
        openWindow()?.show();
        openWindow()?.focus();
      });
      notification.on("close", () => notifications.delete(notification));
      notification.show();
    },
    openLink: (url) => void bestEffort("open page link", shell.openExternal(url)),
    copy: (text) => {
      clipboard.writeText(text);
      return true;
    },
    removed: () => void removed(),
    viewed: (view) => showMenu(view.page.botId, view.page.id),
  });

  function showDialog(options: MessageBoxOptions) {
    const parent = openWindow();
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  }

  function showMenu(botId: string | null, pageId: string) {
    const current = openWindow();
    if (!current) return;
    setPageAppMenu(
      pageAppMenu({
        name: title,
        win: current,
        canOpenInRakazo: botId !== null,
        openInRakazo: () => {
          if (botId === null) return;
          const link = `rakazo://app/${encodeURIComponent(botId)}?page=${encodeURIComponent(pageId)}`;
          void bestEffort("open page in Rakazo", shell.openExternal(link));
        },
        reload: () => controller.refresh(true),
        uninstall: () => void uninstall(),
      }),
    );
  }

  async function uninstall() {
    const { response } = await showDialog({
      type: "warning",
      message: t("Uninstall {name}?", { name: title }),
      buttons: [t("Uninstall"), t("Cancel")],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
    controller.stop();
    await removeSelf(await revokePageAppToken(api));
  }

  handleIpc("desktop.pageApp.ready", () => controller.screen());
  handleIpc("desktop.pageApp.message", (_event, data, frame) => controller.message(data, frame));
  servePageApp(controller.frameDocument);
  win = await createPageAppWindow(title);
  desktop.pageAppWindow = win;
  win.on("closed", () => app.quit());
  win.on("focus", () => controller.refresh());
  nativeTheme.on("updated", () => controller.refresh());
  showMenu(null, pageId);
  if (token === null) return removed();
  controller.start();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = desktop.pageAppWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.on("window-all-closed", () => app.quit());
  void app.whenReady().then(start);
}
