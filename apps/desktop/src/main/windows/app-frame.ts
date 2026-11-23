import type { IpcMainInvokeEvent, WebContents } from "electron";

export type AppTarget = { webContents: WebContents; url: string };

/** The app window's own page: never a subframe, another window, or another origin. */
export function fromAppFrame(
  target: AppTarget | null,
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
): boolean {
  try {
    if (
      !target ||
      target.webContents.isDestroyed() ||
      event.sender !== target.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !event.senderFrame
    )
      return false;
    const origin = new URL(target.url).origin;
    return origin !== "null" && new URL(event.senderFrame.url).origin === origin;
  } catch {
    return false;
  }
}
