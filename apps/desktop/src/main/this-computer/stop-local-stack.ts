import type {
  DesktopInstanceMode,
  DesktopLocalStackPhase,
  DesktopLocalStackState,
} from "@rakazo/contracts";
import type { MenuItemConstructorOptions } from "electron";
import { t } from "../i18n.js";
import { managedLocalOpenUrl } from "../setup/setup-config.js";
import { reportDesktopError } from "../system/monitoring.js";
import type { StackController } from "./local-stack.js";

/**
 * Quit and Stop Bots applies whenever the app manages a local stack: connected in `new`
 * mode, or one that may still be running while a switch away from it stops it.
 */
export function stackStopAvailable(
  mode: DesktopInstanceMode | null | undefined,
  stackRunning: boolean,
): boolean {
  return mode === "new" || stackRunning;
}

export function quitAndStopBotsItem(input: {
  mode: DesktopInstanceMode | null | undefined;
  stackRunning: boolean;
  /** Deactivates local computer access and stops the stack. */
  stop: () => Promise<DesktopLocalStackState>;
  quit: () => void;
  rebuildMenu: () => void;
}): MenuItemConstructorOptions {
  return {
    id: "quit-and-stop-bots",
    label: t("Quit and Stop Bots"),
    visible: stackStopAvailable(input.mode, input.stackRunning),
    // A plain quit leaves the stack running (bots are always on); this is the explicit off switch.
    click: () => {
      const stopped = input.stop();
      // Immediate rebuild: deactivating computer access changes other menu items.
      input.rebuildMenu();
      // A failed stop stays open so its error can be read and retried. A rejected stop is
      // reported, so the menu's click handler never leaks an unhandled rejection.
      void stopped
        .then((state) => {
          if (state.phase !== "failed") input.quit();
        })
        .catch((error: unknown) => reportDesktopError(error, "desktop.menu"))
        .finally(() => input.rebuildMenu());
    },
  };
}

const STARTING = new Set<DesktopLocalStackPhase>([
  "checking-docker",
  "docker-not-running",
  "preparing",
  "pulling",
  "starting",
  "waiting-healthy",
]);

/** Bots on a stack the user switched away from would keep running out of sight. */
export function stopStackLeftBehind(input: {
  mode: DesktopInstanceMode | null | undefined;
  serverUrl: string | undefined;
  previousMode: DesktopInstanceMode | null | undefined;
  stack: Pick<StackController, "managedStackRunning" | "state" | "stop" | "webUrl">;
  rebuildMenu: () => void;
}): void {
  if (input.mode === "new") return;
  // Its own address entered as an existing server still needs it running.
  if (
    input.serverUrl !== undefined &&
    managedLocalOpenUrl(input.serverUrl, input.stack.webUrl()) !== null
  )
    return;
  // Leaving This computer always stops it: containers from an older version can still run
  // unflagged. A start still pulling or waiting for Docker has not launched anything yet, but would.
  if (
    input.previousMode !== "new" &&
    !input.stack.managedStackRunning() &&
    !STARTING.has(input.stack.state().phase)
  )
    return;
  // A stop that only ended a reused stack changes no phase, so the settled state rebuilds the menu.
  void input.stack
    .stop()
    .catch((error: unknown) => reportDesktopError(error, "desktop.ipc"))
    .finally(() => input.rebuildMenu());
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
