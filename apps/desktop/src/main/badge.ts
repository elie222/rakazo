import type { WebContents } from "electron";
import type { IpcCaller } from "./ipc.js";

export function createBadgeHandler(setBadgeCount: (count: number) => boolean) {
  // The window that set the count. A destroyed window runs no React cleanup, so
  // clear its count here unless a replacement window has taken over.
  let owner: WebContents | null = null;
  return (event: Pick<IpcCaller, "sender">, count: unknown): boolean => {
    try {
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
