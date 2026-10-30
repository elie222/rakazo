import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenPermissionApi } from "./host-screen.js";
import {
  createDesktopHostScreen,
  ensureScreenPermissions,
  SCREEN_LOCKED_MESSAGE,
  SCREEN_PERMISSION_MESSAGE,
} from "./host-screen.js";

const desktop = path.resolve(import.meta.dirname, "..");
const scope = { botId: "bot-1", signal: new AbortController().signal };

function permissions(accessibility: boolean, screen: string[]) {
  const statuses = [...screen];
  return {
    isTrustedAccessibilityClient: vi.fn(() => accessibility),
    getMediaAccessStatus: vi.fn(() => statuses.shift() ?? "denied"),
    requestScreenCapture: vi.fn(async () => []),
  } satisfies ScreenPermissionApi;
}

describe("screen permissions", () => {
  it("passes once both are granted without asking for Screen Recording again", async () => {
    const api = permissions(true, ["granted", "granted"]);
    await ensureScreenPermissions(api);
    expect(api.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
    expect(api.requestScreenCapture).not.toHaveBeenCalled();
  });

  it("asks for Screen Recording while it is missing and refuses until it is granted", async () => {
    const api = permissions(true, ["not-determined", "denied"]);
    await expect(ensureScreenPermissions(api)).rejects.toThrow(SCREEN_PERMISSION_MESSAGE);
    expect(api.requestScreenCapture).toHaveBeenCalledOnce();
  });

  it("refuses without Accessibility", async () => {
    await expect(ensureScreenPermissions(permissions(false, ["granted"]))).rejects.toThrow(
      SCREEN_PERMISSION_MESSAGE,
    );
  });
});

describe("desktop screen", () => {
  let dir: string;
  let command: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rakazo-desktop-screen-"));
    command = path.join(dir, "cua-driver");
    await writeFile(command, "");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("exists only on macOS with the driver bundled", () => {
    const options = {
      command,
      home: dir,
      permissions: permissions(true, []),
      locked: () => false,
    };
    expect(createDesktopHostScreen({ ...options, platform: "darwin" })).toBeDefined();
    expect(createDesktopHostScreen({ ...options, platform: "win32" })).toBeUndefined();
    expect(
      createDesktopHostScreen({
        ...options,
        platform: "darwin",
        command: path.join(dir, "missing"),
      }),
    ).toBeUndefined();
  });

  it("says the screen is locked before starting anything", async () => {
    const api = permissions(true, ["granted", "granted"]);
    const screen = createDesktopHostScreen({
      platform: "darwin",
      command,
      home: dir,
      permissions: api,
      locked: () => true,
    })!;
    await expect(screen.observe(scope, "TextEdit")).rejects.toThrow(SCREEN_LOCKED_MESSAGE);
    await expect(screen.act(scope, "TextEdit", [{ kind: "wait", ms: 0 }])).rejects.toThrow(
      SCREEN_LOCKED_MESSAGE,
    );
    expect(api.isTrustedAccessibilityClient).not.toHaveBeenCalled();
  });
});

describe("bundled screen driver", () => {
  it("pins one checksummed release and ships it signed by its publisher", async () => {
    const release = JSON.parse(
      await readFile(path.join(desktop, "native", "screen-driver", "release.json"), "utf8"),
    );
    expect(release.url).toBe(
      `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${release.version}/${release.root}.tar.gz`,
    );
    expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
    const mac = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8")).build.mac;
    expect(mac.extraResources).toContainEqual(
      expect.objectContaining({ from: "build/screen-driver", to: "screen-driver" }),
    );
    expect(mac.signIgnore).toContain("screen-driver/cua-driver$");
  });
});
