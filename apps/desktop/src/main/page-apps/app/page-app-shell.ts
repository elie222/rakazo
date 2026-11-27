import type { BrowserWindow } from "electron";
import type { IpcCaller } from "../../ipc/ipc.js";

/** Serves the app window's shell and the page's frame, each with its own policy. */
export const PAGE_APP_SCHEME = "rakazo-page-app";
export const SHELL_ORIGIN = `${PAGE_APP_SCHEME}://shell`;
export const SHELL_URL = `${SHELL_ORIGIN}/page-app-shell.html`;
export const FRAME_ORIGIN = `${PAGE_APP_SCHEME}://frame`;

/** What the window shows, in the app's language: the page's frame by its address, or a short message. */
export type PageAppScreen = { lang: string } & (
  | { frame: string; title: string }
  | { message: string }
);

/** The bridge the shell's preload exposes. Messages are the frame's, passed on unread. */
export interface PageAppShell {
  ready: () => Promise<PageAppScreen | null>;
  /** The answer to post back to the frame, if the message has one. */
  message: (data: unknown) => Promise<unknown>;
}

/** The app window's own shell page; never the page's frame, which has no bridge anyway. */
export function fromPageAppShell(window: BrowserWindow | null, event: IpcCaller): boolean {
  return (
    window !== null &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url.startsWith(`${SHELL_ORIGIN}/`)
  );
}
