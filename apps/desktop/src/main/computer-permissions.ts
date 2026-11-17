import type { EventEmitter } from "node:events";
import { once } from "node:events";
import { bestEffort } from "@rakazo/logging";
import type { ScreenPermissionApi } from "./host-screen.js";

type SetupAction = "settings" | "restart" | "later";

/** Dock activation also returns to a Mac app that has no open browser window. */
export async function waitForComputerSetupReturn(events: EventEmitter) {
  const listeners = new AbortController();
  try {
    await Promise.race([
      once(events, "activate", { signal: listeners.signal }),
      once(events, "browser-window-focus", { signal: listeners.signal }),
    ]);
  } finally {
    listeners.abort();
  }
}

/** Consent is saved before this runs, so reopening the app keeps the person's choice. */
export function createComputerPermissionSetup(deps: {
  platform: NodeJS.Platform;
  permissions: ScreenPermissionApi;
  showSetup: (readyForRestart: boolean) => Promise<SetupAction>;
  openSettings: () => Promise<unknown>;
  restart: () => void;
}) {
  let pending: { valid: () => boolean; promise: Promise<void> } | undefined;

  async function prepare(valid: () => boolean) {
    if (deps.platform !== "darwin" || !valid()) return;
    const accessibility = deps.permissions.isTrustedAccessibilityClient(false);
    const screen = deps.permissions.getMediaAccessStatus("screen") === "granted";
    if (accessibility && screen) return;

    if (!accessibility) deps.permissions.isTrustedAccessibilityClient(true);
    if (!screen)
      await bestEffort("request Mac screen permission", deps.permissions.requestScreenCapture());

    let readyForRestart = false;
    while (valid()) {
      const action = await deps.showSetup(readyForRestart);
      if (!valid()) return;
      if (action === "later") return;
      if (action === "restart") {
        deps.restart();
        return;
      }
      // Resolves only when the person returns to Rakazo.
      await deps.openSettings();
      if (!valid()) return;
      const accessibility = deps.permissions.isTrustedAccessibilityClient(false);
      const screen = deps.permissions.getMediaAccessStatus("screen") === "granted";
      readyForRestart = accessibility && screen;
    }
  }

  return async (valid: () => boolean = () => true) => {
    if (!valid()) return;
    while (pending) {
      const active = pending;
      const completed = await bestEffort(
        "wait for Mac app control setup",
        active.promise.then(() => true),
      );
      // An active approval already received the shared guide. A cancelled one did not.
      if ((completed && active.valid()) || !valid()) return;
    }
    const active = { valid, promise: prepare(valid) };
    pending = active;
    try {
      await active.promise;
    } finally {
      if (pending === active) pending = undefined;
    }
  };
}
