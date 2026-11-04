import type { DesktopInstanceMode } from "@rakazo/contracts";
import type { MenuItemConstructorOptions } from "electron";
import { t } from "./i18n.js";

/**
 * The menu's stack off-switch applies whenever the app manages a local stack: connected
 * in `new` mode, or one that may still be running after the app switched to another
 * server. A setup without such a stack has nothing to stop.
 */
export function stackStopAvailable(
  mode: DesktopInstanceMode | null | undefined,
  stackRunning: boolean,
): boolean {
  return mode === "new" || stackRunning;
}

export function stopLocalStackItem(input: {
  mode: DesktopInstanceMode | null | undefined;
  stackRunning: boolean;
  stop: () => void;
}): MenuItemConstructorOptions {
  return {
    id: "stop-local-stack",
    label: t("Stop Local Stack"),
    visible: stackStopAvailable(input.mode, input.stackRunning),
    // The stack keeps running after quit (bots are always on); this is the explicit off switch.
    click: () => input.stop(),
  };
}

/**
 * A stack can start or stop without a server switch, so its lifecycle changes must be able
 * to rebuild the menu. Only a flip of the stop item's availability rebuilds: a start's
 * docker output pushes a state change per line, and the menu does not depend on those.
 */
export class StackStopMenuAvailability {
  /** Starts unavailable: until a lifecycle event says otherwise, the menu needs no rebuild. */
  private available = false;

  constructor(
    private readonly read: () => { mode: DesktopInstanceMode | null; running: boolean },
    private readonly rebuildMenu: () => void,
  ) {}

  stackChanged(): void {
    const { mode, running } = this.read();
    const available = stackStopAvailable(mode, running);
    if (available !== this.available) {
      this.available = available;
      this.rebuildMenu();
    }
  }
}
