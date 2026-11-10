import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { AppTarget } from "./app-frame.js";
import { fromAppFrame } from "./app-frame.js";

export function createBadgeHandler(
  getTarget: () => AppTarget | null,
  setBadgeCount: (count: number) => boolean,
) {
  // The window that set the count. A destroyed window runs no React cleanup, so
  // clear its count here unless a replacement window has taken over.
  let owner: WebContents | null = null;
  return (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, count: unknown): boolean => {
    try {
      if (!fromAppFrame(getTarget(), event)) return false;
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
