import type { IpcMainInvokeEvent } from "electron";
import type { AppTarget } from "./app-frame.js";
import { fromAppFrame } from "./app-frame.js";

export function createClipboardHandler(
  getTarget: () => AppTarget | null,
  writeText: (text: string) => void,
) {
  return (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, text: unknown): boolean => {
    try {
      if (!fromAppFrame(getTarget(), event) || typeof text !== "string") return false;
      writeText(text);
      return true;
    } catch {
      return false;
    }
  };
}
