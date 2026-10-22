import type { IpcMainInvokeEvent, WebContents } from "electron";

export function createBadgeHandler(
  getTarget: () => { webContents: WebContents; url: string } | null,
  setBadgeCount: (count: number) => boolean,
) {
  // The window that set the count. A destroyed window runs no React cleanup, so
  // clear its count here unless a replacement window has taken over.
  let owner: WebContents | null = null;
  return (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, count: unknown): boolean => {
    try {
      const target = getTarget();
      if (
        !target ||
        target.webContents.isDestroyed() ||
        event.sender !== target.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        !event.senderFrame
      )
        return false;
      const origin = new URL(target.url).origin;
      if (origin === "null" || new URL(event.senderFrame.url).origin !== origin) return false;
      const valid = typeof count === "number" && Number.isInteger(count) && count >= 0;
      const sender = event.sender;
      if (owner !== sender) {
        owner = sender;
        sender.once("destroyed", () => {
          if (owner !== sender) return;
          owner = null;
          try {
            setBadgeCount(0);
          } catch {
            // Platforms without badges have nothing to clear.
          }
        });
      }
      return setBadgeCount(valid ? Math.min(count, 9999) : 0);
    } catch {
      return false;
    }
  };
}
