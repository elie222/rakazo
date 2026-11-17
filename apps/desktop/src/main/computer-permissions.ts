import type { EventEmitter } from "node:events";
import { once } from "node:events";
import { bestEffort } from "@rakazo/logging";
import type { ScreenPermissionApi } from "./host-screen.js";

type SetupAction = "settings" | "restart" | "later";

/** Dock activation also returns to a Mac app that has no open browser window. */
export async function waitForComputerSetupReturn(
  events: EventEmitter,
  openSettings: () => Promise<unknown>,
) {
  const listeners = new AbortController();
  try {
    const returned = Promise.race([
      once(events, "activate", { signal: listeners.signal }),
      once(events, "browser-window-focus", { signal: listeners.signal }),
    ]);
    // Invoke after subscribing, and turn synchronous launch errors into rejections too.
    const opening = async () => openSettings();
    await Promise.all([returned, opening()]);
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

    while (valid()) {
      const accessibility = deps.permissions.isTrustedAccessibilityClient(false);
      const screen = deps.permissions.getMediaAccessStatus("screen") === "granted";
      const action = await deps.showSetup(accessibility && screen);
      if (!valid()) return;
      if (action === "later") return;
      if (action === "restart") {
        deps.restart();
        return;
      }
      // Resolves only when the person returns to Rakazo.
      await deps.openSettings();
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
