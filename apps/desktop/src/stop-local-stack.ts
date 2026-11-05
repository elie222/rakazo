import type { DesktopInstanceMode, DesktopLocalStackPhase } from "@rakazo/contracts";
import type { MenuItemConstructorOptions } from "electron";
import { t } from "./i18n.js";
import { reportDesktopError } from "./monitoring.js";

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
  /** Deactivates local computer access and stops the stack. */
  stop: () => unknown;
  rebuildMenu: () => void;
}): MenuItemConstructorOptions {
  return {
    id: "stop-local-stack",
    label: t("Stop Local Stack"),
    visible: stackStopAvailable(input.mode, input.stackRunning),
    // The stack keeps running after quit (bots are always on); this is the explicit off switch.
    click: () => {
      const stopped = Promise.resolve(input.stop());
      // Immediate rebuild: deactivating computer access changes other menu items.
      input.rebuildMenu();
      // A stop that only ended a reused stack changes no phase, so no lifecycle event
      // follows; the settled state decides the item's visibility. A rejected stop is
      // reported, so the menu's click handler never leaks an unhandled rejection.
      void stopped
        .catch((error: unknown) => reportDesktopError(error, "desktop.menu"))
        .finally(() => input.rebuildMenu());
    },
  };
}

/**
 * A stack can start or stop without a server switch, so its lifecycle transitions must be
 * able to rebuild the menu. A phase transition is the signal, and the only thing kept is
 * the last phase — which changes solely through these transitions — so no cached
 * availability can drift from whatever the menu was last rebuilt around. Docker output
 * pushes a state change per line without changing the phase, and the menu does not
 * depend on those lines.
 */
export class StackStopMenuAvailability {
  private phase: DesktopLocalStackPhase | undefined;

  constructor(private readonly rebuildMenu: () => void) {}

  stackChanged(phase: DesktopLocalStackPhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.rebuildMenu();
  }

  /** A confirmed reuse changes no phase; rebuild around the new running state. */
  reuseConfirmed(): void {
    this.rebuildMenu();
  }
}
