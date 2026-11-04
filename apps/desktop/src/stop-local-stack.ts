import type { DesktopInstanceMode, DesktopLocalStackPhase } from "@rakazo/contracts";
import type { MenuItemConstructorOptions } from "electron";
import { t } from "./i18n.js";

/**
 * The menu's stack off-switch applies whenever the app manages a local stack: connected
 * in `new` mode, or one it started that may still be running after the app switched to
 * another server. An `existing` setup that never started a stack has nothing to stop.
 */
export function stackStopAvailable(
  mode: DesktopInstanceMode | null | undefined,
  phase: DesktopLocalStackPhase,
): boolean {
  return mode === "new" || phase !== "idle";
}

export function stopLocalStackItem(input: {
  mode: DesktopInstanceMode | null | undefined;
  phase: DesktopLocalStackPhase;
  stop: () => void;
}): MenuItemConstructorOptions {
  return {
    id: "stop-local-stack",
    label: t("Stop Local Stack"),
    visible: stackStopAvailable(input.mode, input.phase),
    // The stack keeps running after quit (bots are always on); this is the explicit off switch.
    click: () => input.stop(),
  };
}
