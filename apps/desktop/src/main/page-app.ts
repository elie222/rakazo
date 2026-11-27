import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PageAbility } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging";
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
import { adoptLauncherIdentity, launcherIcon, removeOwnLauncher } from "./page-apps/launchers.js";
import { createPageAppApi, revokePageAppToken } from "./page-apps/page-app-api.js";
import {
  PAGE_APP_CONFIG_FILE,
  pageAppConfig,
  pageAppDataDir,
  readPageAppToken,
  removePageAppData,
} from "./page-apps/page-app-files.js";
import { launchedPageAppId } from "./page-apps/page-app-launch.js";
import { systemWindowBackground } from "./windows/window-options.js";

/** Set when a Windows or Linux launcher started Rakazo as this app; macOS apps are bundles. */
const launchedId = launchedPageAppId(process.argv, process.platform);
const appData = app.getPath("appData");
const configFile = path.join(
  launchedId === null ? process.resourcesPath : pageAppDataDir(launchedId, appData),
  PAGE_APP_CONFIG_FILE,
);
// A launcher the system kept after uninstalling, such as a taskbar pin, starts nothing.
if (launchedId !== null && !existsSync(configFile)) process.exit(0);
const config = pageAppConfig(JSON.parse(readFileSync(configFile, "utf8")));
if (!config || (process.platform !== "darwin" && config.appId !== launchedId))
  throw new Error("This page app's config is not usable.");
const { appId, pageId, title, server } = config;

app.setName(title);
app.setPath("userData", pageAppDataDir(appId, appData));
if (launchedId !== null) adoptLauncherIdentity(appId);
registerPageAppScheme();

/**
 * Removes this app. Its data goes only with a revoked token: otherwise a Mac app waits in the
 * Trash, and a launcher's app stays installed, for the revoke to be tried again.
 */
async function removeSelf(revoked: boolean) {
  if (launchedId !== null && !revoked) return app.exit(0);
  if (launchedId === null) await bestEffort("trash page app", shell.trashItem(runningBundle()));
  else await bestEffort("remove page app launcher", removeOwnLauncher(appId, appData));
  if (revoked) await bestEffort("remove page app data", removePageAppData(appId, appData));
  app.exit(0);
}

async function start() {
  startDesktopLocale(null, app.getPreferredSystemLanguages()[0] ?? app.getLocale());
  const token = await readPageAppToken(appId, appData);
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
      buttons: [launchedId === null ? t("Move to Trash") : t("Uninstall"), t("Quit")],
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
  win = await createPageAppWindow(
    title,
    launchedId === null ? undefined : launcherIcon(appId, appData),
  );
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
