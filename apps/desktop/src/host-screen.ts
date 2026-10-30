import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createCuaHostScreen, cuaDriverConnector } from "@rakazo/adapters/cua-host-screen";
import type { HostScreen } from "@rakazo/adapters/host-screen";
import { HostScreenError } from "@rakazo/adapters/host-screen";

export const SCREEN_LOCKED_MESSAGE =
  "The user's screen is locked, so their apps can't be seen or used. Ask them to unlock it, then try again.";
export const SCREEN_DRIVER_DOWNLOAD_MESSAGE =
  "Screen control couldn't be set up on this computer. Ask the user to check their internet connection, then try again.";
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

/** The one driver release this app runs. Changing it is a reviewed edit to this pin. */
export const SCREEN_DRIVER_RELEASE = {
  url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
  sha256: "2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732",
  driverSha256: "92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f",
};

async function fileSha256(file: string) {
  try {
    return createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Downloads the pinned driver into `dir` the first time it is needed, so only people who use
 * screen control pay for it, and returns its path. Any other download is refused, and earlier
 * versions are removed. The driver runs with this app's macOS permissions, so it is checked
 * again before every start and replaced if anything changed it.
 */
export function screenDriverInstaller(options: {
  dir: string;
  fetch: (url: string) => Promise<Response>;
  release?: typeof SCREEN_DRIVER_RELEASE;
}): () => Promise<string> {
  const release = options.release ?? SCREEN_DRIVER_RELEASE;
  const command = path.join(options.dir, release.driverSha256, "cua-driver");
  let pending: Promise<string> | undefined;

  async function install() {
    await mkdir(options.dir, { recursive: true });
    const staging = await mkdtemp(path.join(options.dir, ".download-"));
    try {
      const response = await options.fetch(release.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const archive = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(archive).digest("hex") !== release.sha256)
        throw new Error("checksum mismatch");
      const archivePath = path.join(staging, "driver.tar.gz");
      await writeFile(archivePath, archive);
      await promisify(execFile)("/usr/bin/tar", ["-xzf", archivePath, "-C", staging, "cua-driver"]);
      await rm(archivePath);
      if ((await fileSha256(path.join(staging, "cua-driver"))) !== release.driverSha256)
        throw new Error("checksum mismatch");
      for (const entry of await readdir(options.dir))
        if (entry !== path.basename(staging))
          await rm(path.join(options.dir, entry), { recursive: true, force: true });
      await rename(staging, path.dirname(command));
      return command;
    } catch {
      throw new HostScreenError(SCREEN_DRIVER_DOWNLOAD_MESSAGE);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async function verified() {
    return (await fileSha256(command)) === release.driverSha256 ? command : install();
  }

  return () => {
    pending ??= verified().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Screen control for this Mac, or undefined on other platforms. */
export function createDesktopHostScreen(options: {
  platform: NodeJS.Platform;
  /** Resolves to the driver executable, fetching it first if needed. */
  driver: () => Promise<string>;
  home: string;
  permissions: ScreenPermissionApi;
  /** A locked Mac hides every window, so apps opened behind the lock screen show none. */
  locked: () => boolean;
}): HostScreen | undefined {
  if (options.platform !== "darwin") return undefined;
  const screen = createCuaHostScreen({
    connect: async () =>
      cuaDriverConnector({ command: await options.driver(), home: options.home })(),
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
