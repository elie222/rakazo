import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HostScreenError } from "@rakazo/adapters/host-screen";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenPermissionApi } from "./host-screen.js";
import {
  createDesktopHostScreen,
  ensureScreenPermissions,
  SCREEN_DRIVER_DOWNLOAD_MESSAGE,
  SCREEN_DRIVER_RELEASE,
  SCREEN_LOCKED_MESSAGE,
  SCREEN_PERMISSION_MESSAGE,
  screenDriverInstaller,
} from "./host-screen.js";

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
  const options = {
    driver: async () => "/missing/cua-driver",
    home: "/missing",
    locked: () => false,
  };

  it("exists only on macOS", () => {
    const api = permissions(true, []);
    expect(
      createDesktopHostScreen({ ...options, permissions: api, platform: "darwin" }),
    ).toBeDefined();
    expect(
      createDesktopHostScreen({ ...options, permissions: api, platform: "win32" }),
    ).toBeUndefined();
  });

  it("says the screen is locked before starting anything", async () => {
    const api = permissions(true, ["granted", "granted"]);
    const driver = vi.fn(options.driver);
    const screen = createDesktopHostScreen({
      ...options,
      driver,
      platform: "darwin",
      permissions: api,
      locked: () => true,
    })!;
    await expect(screen.observe(scope, "TextEdit")).rejects.toThrow(SCREEN_LOCKED_MESSAGE);
    await expect(screen.act(scope, "TextEdit", [{ kind: "wait", ms: 0 }])).rejects.toThrow(
      SCREEN_LOCKED_MESSAGE,
    );
    expect(api.isTrustedAccessibilityClient).not.toHaveBeenCalled();
    expect(driver).not.toHaveBeenCalled();
  });

  it("fetches the driver only once the permissions are granted", async () => {
    const driver = vi.fn(async () => {
      throw new HostScreenError(SCREEN_DRIVER_DOWNLOAD_MESSAGE);
    });
    const denied = createDesktopHostScreen({
      ...options,
      driver,
      platform: "darwin",
      permissions: permissions(false, ["granted"]),
    })!;
    await expect(denied.observe(scope, "TextEdit")).rejects.toThrow(SCREEN_PERMISSION_MESSAGE);
    expect(driver).not.toHaveBeenCalled();
    const granted = createDesktopHostScreen({
      ...options,
      driver,
      platform: "darwin",
      permissions: permissions(true, ["granted", "granted"]),
    })!;
    await expect(granted.observe(scope, "TextEdit")).rejects.toThrow(
      SCREEN_DRIVER_DOWNLOAD_MESSAGE,
    );
  });
});

describe("screen driver download", () => {
  let dir: string;
  let archive: Buffer;
  let release: typeof SCREEN_DRIVER_RELEASE;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rakazo-screen-driver-"));
    const source = path.join(dir, "source");
    await mkdir(source);
    await writeFile(path.join(source, "cua-driver"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(path.join(source, "libcua_driver_sdk.dylib"), "unused");
    execFileSync("tar", [
      "-czf",
      path.join(dir, "driver.tar.gz"),
      "-C",
      source,
      "cua-driver",
      "libcua_driver_sdk.dylib",
    ]);
    archive = await readFile(path.join(dir, "driver.tar.gz"));
    release = {
      url: "https://example.test/driver.tar.gz",
      sha256: createHash("sha256").update(archive).digest("hex"),
      driverSha256: createHash("sha256").update("#!/bin/sh\n").digest("hex"),
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const serve = (body: Buffer) => vi.fn(async () => new Response(new Uint8Array(body)));

  it("downloads the pinned driver once, keeps only it, and reuses it after a restart", async () => {
    const bin = path.join(dir, "bin");
    await mkdir(path.join(bin, "older-version"), { recursive: true });
    const fetch = serve(archive);
    const install = screenDriverInstaller({ dir: bin, fetch, release });
    const [command, again] = await Promise.all([install(), install()]);
    expect(again).toBe(command);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(release.url);
    expect(await readFile(command, "utf8")).toBe("#!/bin/sh\n");
    expect(await readdir(bin)).toEqual([release.driverSha256]);
    expect(await readdir(path.dirname(command))).toEqual(["cua-driver"]);
    const restarted = screenDriverInstaller({ dir: bin, fetch, release });
    await expect(restarted()).resolves.toBe(command);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("replaces a cached driver that something else changed before starting it", async () => {
    const bin = path.join(dir, "bin");
    const fetch = serve(archive);
    const install = screenDriverInstaller({ dir: bin, fetch, release });
    const command = await install();
    await writeFile(command, "#!/bin/sh\necho replaced\n");
    await expect(install()).resolves.toBe(command);
    expect(await readFile(command, "utf8")).toBe("#!/bin/sh\n");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses anything but the pinned archive and tries again next time", async () => {
    const bin = path.join(dir, "bin");
    const fetch = serve(Buffer.from("tampered"));
    const install = screenDriverInstaller({ dir: bin, fetch, release });
    await expect(install()).rejects.toThrow(SCREEN_DRIVER_DOWNLOAD_MESSAGE);
    expect(await readdir(bin)).toEqual([]);
    fetch.mockImplementationOnce(async () => new Response("", { status: 503 }));
    await expect(install()).rejects.toThrow(SCREEN_DRIVER_DOWNLOAD_MESSAGE);
    fetch.mockImplementationOnce(async () => new Response(new Uint8Array(archive)));
    await expect(install()).resolves.toBe(path.join(bin, release.driverSha256, "cua-driver"));
  });

  it("pins one checksummed release from the driver's publisher", () => {
    expect(SCREEN_DRIVER_RELEASE.url).toMatch(
      /^https:\/\/github\.com\/trycua\/cua\/releases\/download\/cua-driver-rs-v[\d.]+\/cua-driver-rs-[\d.]+-darwin-universal-binary\.tar\.gz$/,
    );
    expect(SCREEN_DRIVER_RELEASE.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(SCREEN_DRIVER_RELEASE.driverSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
