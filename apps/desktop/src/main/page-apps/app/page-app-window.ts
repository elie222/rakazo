import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SANDBOXED_ARTIFACT_CSP } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type { MenuItemConstructorOptions, Rectangle } from "electron";
import { app, BrowserWindow, Menu, nativeTheme, protocol, screen, session } from "electron";
import { t } from "../../i18n.js";
import { systemWindowBackground } from "../../windows/window-options.js";
import { FRAME_ORIGIN, PAGE_APP_SCHEME, SHELL_ORIGIN, SHELL_URL } from "./page-app-shell.js";

/** The shell runs only its own files and frames only the page; the page keeps the sandbox policy. */
const SHELL_CSP = `default-src 'none'; script-src ${SHELL_ORIGIN}; style-src ${SHELL_ORIGIN}; frame-src ${FRAME_ORIGIN}; base-uri 'none'; form-action 'none'`;
const FRAME_CSP = `${SANDBOXED_ARTIFACT_CSP}; sandbox allow-scripts`;
const SHELL_FILES: Record<string, string> = {
  "/page-app-shell.html": "text/html; charset=utf-8",
  "/page-app-shell.css": "text/css; charset=utf-8",
  "/page-app-shell.js": "text/javascript; charset=utf-8",
};

/** Before the app is ready: the shell and frame are served from the app's own scheme. */
export function registerPageAppScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: PAGE_APP_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

export function servePageApp(frameDocument: (id: number) => string | null) {
  protocol.handle(PAGE_APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    const type = SHELL_FILES[url.pathname];
    if (origin === SHELL_ORIGIN && type) {
      const body = await readFile(path.join(import.meta.dirname, url.pathname.slice(1)));
      return new Response(body, {
        headers: { "content-type": type, "content-security-policy": SHELL_CSP },
      });
    }
    const id = Number(url.pathname.slice(1));
    const document = origin === FRAME_ORIGIN && Number.isInteger(id) ? frameDocument(id) : null;
    if (document === null) return new Response(null, { status: 404 });
    return new Response(document, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": FRAME_CSP,
        "cache-control": "no-store",
      },
    });
  });
}

type WindowState = { bounds?: Rectangle; onTop?: boolean };

function stateFile() {
  return path.join(app.getPath("userData"), "window.json");
}

async function readWindowState(): Promise<WindowState> {
  try {
    const value = JSON.parse(await readFile(stateFile(), "utf8")) as WindowState;
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}

function visible(bounds: Rectangle | undefined): Rectangle | undefined {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite))
    return undefined;
  const area = screen.getDisplayMatching(bounds).workArea;
  const overlaps =
    bounds.x < area.x + area.width &&
    bounds.x + bounds.width > area.x &&
    bounds.y < area.y + area.height &&
    bounds.y + bounds.height > area.y;
  return overlaps ? bounds : undefined;
}

/** The app's one window: the shell page in the sandbox, nothing it can navigate or open. */
export async function createPageAppWindow(title: string) {
  const saved = await readWindowState();
  const bounds = visible(saved.bounds);
  const win = new BrowserWindow({
    title,
    width: bounds?.width ?? 1040,
    height: bounds?.height ?? 760,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 360,
    minHeight: 280,
    show: false,
    alwaysOnTop: saved.onTop === true,
    backgroundColor: systemWindowBackground(nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: path.join(import.meta.dirname, "page-app-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame || !event.url.startsWith(`${FRAME_ORIGIN}/`)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  win.on("page-title-updated", (event) => event.preventDefault());
  win.once("ready-to-show", () => win.show());
  win.on("close", () => {
    const state: WindowState = { bounds: win.getNormalBounds(), onTop: win.isAlwaysOnTop() };
    void bestEffort("save page app window", writeFile(stateFile(), JSON.stringify(state)));
  });
  await win.loadURL(SHELL_URL);
  return win;
}

export function pageAppMenu(input: {
  name: string;
  win: BrowserWindow;
  canOpenInRakazo: boolean;
  openInRakazo: () => void;
  reload: () => void;
  uninstall: () => void;
}): MenuItemConstructorOptions[] {
  const { name, win } = input;
  return [
    {
      label: name,
      submenu: [
        { role: "about", label: t("About {name}", { name }) },
        { type: "separator" },
        { label: t("Open in Rakazo"), enabled: input.canOpenInRakazo, click: input.openInRakazo },
        { label: t("Uninstall…"), click: input.uninstall },
        { type: "separator" },
        { role: "hide", label: t("Hide {name}", { name }) },
        { role: "hideOthers", label: t("Hide Others") },
        { role: "unhide", label: t("Show All") },
        { type: "separator" },
        { role: "quit", label: t("Quit {name}", { name }) },
      ],
    },
    {
      label: t("Edit"),
      submenu: [
        { role: "undo", label: t("Undo") },
        { role: "redo", label: t("Redo") },
        { type: "separator" },
        { role: "cut", label: t("Cut") },
        { role: "copy", label: t("Copy") },
        { role: "paste", label: t("Paste") },
        { role: "selectAll", label: t("Select All") },
      ],
    },
    {
      label: t("View"),
      submenu: [
        { label: t("Reload"), accelerator: "CommandOrControl+R", click: input.reload },
        { type: "separator" },
        { role: "resetZoom", label: t("Actual Size") },
        { role: "zoomIn", label: t("Zoom In") },
        { role: "zoomOut", label: t("Zoom Out") },
        { type: "separator" },
        { role: "togglefullscreen", label: t("Toggle Full Screen") },
      ],
    },
    {
      label: t("Window"),
      role: "window",
      submenu: [
        {
          label: t("Keep on Top"),
          type: "checkbox",
          checked: win.isAlwaysOnTop(),
          click: (item) => win.setAlwaysOnTop(item.checked),
        },
        { type: "separator" },
        { role: "minimize", label: t("Minimize") },
        { role: "zoom", label: t("Zoom") },
        { role: "close", label: t("Close Window") },
      ],
    },
  ];
}

export function setPageAppMenu(template: MenuItemConstructorOptions[]) {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
