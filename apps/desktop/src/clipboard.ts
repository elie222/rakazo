import { secureHttpOrigin } from "@rakazo/contracts/network-host";
import type { AppTarget } from "./app-frame.js";

export function createClipboardHandler(
  getTarget: () => AppTarget | null,
  writeText: (text: string) => void,
) {
  return (_event: unknown, text: unknown): boolean => {
    try {
      const target = getTarget();
      if (!target || secureHttpOrigin(target.url) === null || typeof text !== "string")
        return false;
      writeText(text);
      return true;
    } catch {
      return false;
    }
  };
}
