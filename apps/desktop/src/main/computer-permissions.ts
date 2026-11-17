import { bestEffort } from "@rakazo/logging";
import type { ScreenPermissionApi } from "./host-screen.js";

type SetupAction = "settings" | "restart" | "later";

/** Consent is saved before this runs, so reopening the app keeps the person's choice. */
export function createComputerPermissionSetup(deps: {
  platform: NodeJS.Platform;
  permissions: ScreenPermissionApi;
  showSetup: (readyForRestart: boolean) => Promise<SetupAction>;
  openSettings: () => Promise<unknown>;
  restart: () => void;
}) {
  let pending: Promise<void> | undefined;

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

  return (valid: () => boolean = () => true) => {
    pending ??= prepare(valid).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
