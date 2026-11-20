import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { AgentDesktopHostScreenOptions } from "@rakazo/adapters/agent-desktop-host-screen";
import {
  agentDesktopCli,
  createAgentDesktopHostScreen,
} from "@rakazo/adapters/agent-desktop-host-screen";
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

export interface ScreenDriverRelease {
  url: string;
  sha256: string;
  /** The archive member that is the driver, and its own checksum. */
  driver: string;
  driverSha256: string;
}

/** The one driver release each platform runs. Changing one is a reviewed edit to its pin. */
export const SCREEN_DRIVER_RELEASES = {
  darwin: {
    url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
    sha256: "2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732",
    driver: "cua-driver",
    driverSha256: "92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f",
  },
  // The desktop ships for x64 Windows only; Windows on Arm runs it, and this, emulated.
  win32: {
    url: "https://github.com/vercel-labs/agent-desktop/releases/download/v1.0.2/agent-desktop-v1.0.2-x86_64-pc-windows-msvc.tar.gz",
    sha256: "2186c76e7df197c0e67365e45d36d869f74714c56bb8a73817e2a66f3e18e222",
    driver: "agent-desktop.exe",
    driverSha256: "409e58cbdd6aed47e29771ffa60bc122a9843505a227af488cded85215943988",
  },
} satisfies Partial<Record<NodeJS.Platform, ScreenDriverRelease>>;

/** The screen driver this platform runs, if it has one. */
export function screenDriverRelease(platform: NodeJS.Platform): ScreenDriverRelease | undefined {
  return platform === "darwin" || platform === "win32"
    ? SCREEN_DRIVER_RELEASES[platform]
    : undefined;
}

// Both ship bsdtar: macOS in /usr/bin, Windows 10 1803 and later in System32.
const TAR =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "/usr/bin/tar";

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
 * versions are removed. The driver runs with this app's permissions, so it is checked again
 * before every start and replaced if anything changed it.
 */
export function screenDriverInstaller(options: {
  dir: string;
  fetch: (url: string) => Promise<Response>;
  release: ScreenDriverRelease;
}): () => Promise<string> {
  const { release } = options;
  const command = path.join(options.dir, release.driverSha256, release.driver);
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
      await promisify(execFile)(TAR, ["-xzf", archivePath, "-C", staging, release.driver]);
      await rm(archivePath);
      if ((await fileSha256(path.join(staging, release.driver))) !== release.driverSha256)
        throw new Error("checksum mismatch");
      for (const entry of await readdir(options.dir))
        if (entry !== path.basename(staging))
          await rm(path.join(options.dir, entry), { recursive: true, force: true });
      await renameSoon(staging, path.dirname(command));
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

/**
 * Windows antivirus briefly holds a new executable open to scan it, which refuses a rename of
 * its folder until the scan ends.
 */
async function renameSoon(from: string, to: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      await sleep(100);
    }
  }
}

/** Screen control for this Mac or Windows PC, or undefined on other platforms. */
export function createDesktopHostScreen(options: {
  platform: NodeJS.Platform;
  /** Resolves to the driver executable, fetching it first if needed. */
  driver: () => Promise<string>;
  home: string;
  /** macOS only: Windows asks no permission to read and drive apps at the user's own level. */
  permissions: ScreenPermissionApi;
  /** A locked screen hides every window, so apps opened behind it show none. */
  locked: () => boolean;
  fitImage?: AgentDesktopHostScreenOptions["fitImage"];
}): HostScreen | undefined {
  let screen: HostScreen;
  if (options.platform === "darwin")
    screen = createCuaHostScreen({
      connect: async () =>
        cuaDriverConnector({ command: await options.driver(), home: options.home })(),
      permissions: () => ensureScreenPermissions(options.permissions),
      selfPid: process.pid,
    });
  else if (options.platform === "win32")
    screen = createAgentDesktopHostScreen({
      run: agentDesktopCli({ command: options.driver, home: options.home }),
      selfPid: process.pid,
      fitImage: options.fitImage,
    });
  else return undefined;
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
