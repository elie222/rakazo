import { existsSync } from "node:fs";
import { createCuaHostScreen, cuaDriverConnector } from "@rakazo/adapters/cua-host-screen";
import type { HostScreen } from "@rakazo/adapters/host-screen";
import { HostScreenError } from "@rakazo/adapters/host-screen";

export const SCREEN_LOCKED_MESSAGE =
  "The user's screen is locked, so their apps can't be seen or used. Ask them to unlock it, then try again.";
export const SCREEN_PERMISSION_MESSAGE =
  "Rakazo needs Accessibility and Screen Recording access on this Mac. Ask the user to allow Rakazo in System Settings > Privacy & Security, quit and reopen Rakazo, then try again.";

/** The parts of Electron's macOS permission API this uses. */
export interface ScreenPermissionApi {
  isTrustedAccessibilityClient(prompt: boolean): boolean;
  getMediaAccessStatus(mediaType: "screen"): string;
  /** Lists windows, which makes macOS ask for Screen Recording the first time. */
  requestScreenCapture(): Promise<unknown>;
}

/**
 * Asks macOS for both permissions, attributed to this app, before the driver starts. Each
 * prompt appears only while its permission is missing, so it never repeats once granted.
 */
export async function ensureScreenPermissions(api: ScreenPermissionApi) {
  const accessibility = api.isTrustedAccessibilityClient(true);
  if (api.getMediaAccessStatus("screen") !== "granted")
    await api.requestScreenCapture().catch(() => undefined);
  if (!accessibility || api.getMediaAccessStatus("screen") !== "granted")
    throw new HostScreenError(SCREEN_PERMISSION_MESSAGE);
}

/** Screen control for this Mac, or undefined where no driver is bundled. */
export function createDesktopHostScreen(options: {
  platform: NodeJS.Platform;
  command: string;
  home: string;
  permissions: ScreenPermissionApi;
  /** A locked Mac hides every window, so apps opened behind the lock screen show none. */
  locked: () => boolean;
}): HostScreen | undefined {
  if (options.platform !== "darwin" || !existsSync(options.command)) return undefined;
  const screen = createCuaHostScreen({
    connect: cuaDriverConnector({ command: options.command, home: options.home }),
    permissions: () => ensureScreenPermissions(options.permissions),
    selfPid: process.pid,
  });
  const unlocked = () => {
    if (options.locked()) throw new HostScreenError(SCREEN_LOCKED_MESSAGE);
  };
  return {
    observe: async (scope, app, observeOptions) => {
      unlocked();
      return screen.observe(scope, app, observeOptions);
    },
    act: async (scope, app, actions) => {
      unlocked();
      return screen.act(scope, app, actions);
    },
    close: () => screen.close(),
  };
}
