import { PAGE_APP_ID } from "./bundle-name.js";

const ARGUMENT = "--page-app=";

/** What a Windows or Linux launcher passes Rakazo to start one installed app instead of itself. */
export function pageAppArgument(appId: string): string {
  if (!PAGE_APP_ID.test(appId)) throw new Error("Invalid page app id.");
  return `${ARGUMENT}${appId}`;
}

/** The app a launcher started, or null when this is Rakazo itself. macOS apps are bundles instead. */
export function launchedPageAppId(argv: readonly string[], platform: NodeJS.Platform) {
  if (platform !== "win32" && platform !== "linux") return null;
  const appId = argv.find((each) => each.startsWith(ARGUMENT))?.slice(ARGUMENT.length);
  return appId !== undefined && PAGE_APP_ID.test(appId) ? appId : null;
}

/** The file a launcher runs: the AppImage itself when Rakazo runs from one, since its mount moves. */
export function launcherExecutable(env: NodeJS.ProcessEnv, execPath: string): string {
  return env.APPIMAGE || execPath;
}
