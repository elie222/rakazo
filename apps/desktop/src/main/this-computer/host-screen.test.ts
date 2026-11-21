import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HostScreenError } from "@rakazo/adapters/host-screen";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenDriverRelease, ScreenPermissionApi } from "./host-screen.js";
import {
  createDesktopHostScreen,
  ensureScreenPermissions,
  runningProcessNamed,
  SCREEN_DRIVER_DOWNLOAD_MESSAGE,
  SCREEN_DRIVER_RELEASES,
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

  it("exists on macOS, Windows and Linux", () => {
    const api = permissions(true, []);
    for (const platform of ["darwin", "win32", "linux"] as const)
      expect(createDesktopHostScreen({ ...options, permissions: api, platform })).toBeDefined();
    expect(
      createDesktopHostScreen({ ...options, permissions: api, platform: "freebsd" }),
    ).toBeUndefined();
  });

  it.each(["win32", "linux"] as const)(
    "asks %s for no permission and fetches the driver on first use",
    async (platform) => {
      const api = permissions(false, []);
      const driver = vi.fn(async () => {
        throw new HostScreenError(SCREEN_DRIVER_DOWNLOAD_MESSAGE);
      });
      const screen = createDesktopHostScreen({
        ...options,
        driver,
        permissions: api,
        platform,
      })!;
      expect(driver).not.toHaveBeenCalled();
      await expect(screen.observe(scope, "notepad")).rejects.toThrow(
        SCREEN_DRIVER_DOWNLOAD_MESSAGE,
      );
      expect(api.isTrustedAccessibilityClient).not.toHaveBeenCalled();
    },
  );

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
  let release: ScreenDriverRelease;
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
      driver: "cua-driver",
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

  it("finds this user's processes by command or executable name", async () => {
    const proc = await mkdtemp(path.join(tmpdir(), "proc-"));
    try {
      const fake = async (pid: string, comm: string, exe: string) => {
        await mkdir(path.join(proc, pid));
        await writeFile(path.join(proc, pid, "comm"), `${comm}\n`);
        await writeFile(
          path.join(proc, pid, "status"),
          `Name:\t${comm}\nUid:\t${process.getuid?.() ?? 0}\t0\t0\t0\n`,
        );
        await symlink(exe, path.join(proc, pid, "exe"));
        await writeFile(path.join(proc, pid, "cmdline"), `${exe}\0`);
      };
      await fake("10", "brave", "/opt/browser/brave");
      await fake("11", "Web Content", "/usr/lib/viewer/viewer-bin");
      await mkdir(path.join(proc, "self"));
      expect(await runningProcessNamed("Brave", proc)).toBe(true);
      expect(await runningProcessNamed("viewer-bin", proc)).toBe(true);
      expect(await runningProcessNamed("viewer", proc)).toBe(false);
      // Another user's process doesn't count, whoever owns its folder.
      await fake("15", "someone-else", "/usr/bin/someone-else");
      await writeFile(path.join(proc, "15", "status"), "Uid:\t4242\t4242\t4242\t4242\n");
      expect(await runningProcessNamed("someone-else", proc)).toBe(false);
      // A process that exits mid-scan leaves an entry whose files are gone.
      await mkdir(path.join(proc, "12"));
      expect(await runningProcessNamed("missing", proc)).toBe(false);
      // The kernel cuts a script's command name to 15 characters; the script's path tells them apart.
      const script = async (pid: string, file: string) => {
        await fake(pid, path.basename(file).slice(0, 15), "/usr/bin/python3.13");
        await writeFile(path.join(proc, pid, "cmdline"), `python3\0${file}\0--quiet\0`);
      };
      await script("13", "/opt/tools/photo-organizer-cli");
      expect(await runningProcessNamed("photo-organizer-app", proc)).toBe(false);
      await script("14", "/opt/tools/photo-organizer-app");
      expect(await runningProcessNamed("photo-organizer-app", proc)).toBe(true);
    } finally {
      await rm(proc, { recursive: true, force: true });
    }
  });

  it("counts only processes of this login session, or of none recorded", async () => {
    const proc = await mkdtemp(path.join(tmpdir(), "proc-"));
    try {
      const fake = async (pid: string, comm: string, session: string) => {
        await mkdir(path.join(proc, pid));
        await writeFile(path.join(proc, pid, "comm"), `${comm}\n`);
        await writeFile(
          path.join(proc, pid, "status"),
          `Name:\t${comm}\nUid:\t${process.getuid?.() ?? 0}\t0\t0\t0\n`,
        );
        await writeFile(path.join(proc, pid, "sessionid"), session);
        await symlink(`/usr/bin/${comm}`, path.join(proc, pid, "exe"));
        await writeFile(path.join(proc, pid, "cmdline"), `/usr/bin/${comm}\0`);
      };
      await fake("self", "rakazo", "3");
      await fake("10", "elsewhere", "4");
      await fake("11", "here", "3");
      await fake("12", "unrecorded", "4294967295");
      expect(await runningProcessNamed("elsewhere", proc)).toBe(false);
      expect(await runningProcessNamed("here", proc)).toBe(true);
      expect(await runningProcessNamed("unrecorded", proc)).toBe(true);
      // A process whose session can't be read stops the scan rather than counting as unrecorded.
      await mkdir(path.join(proc, "13"));
      await writeFile(path.join(proc, "13", "comm"), "unreadable\n");
      await writeFile(path.join(proc, "13", "status"), `Uid:\t${process.getuid?.() ?? 0}\n`);
      await mkdir(path.join(proc, "13", "sessionid"));
      await expect(runningProcessNamed("unreadable", proc)).rejects.toThrow();
    } finally {
      await rm(proc, { recursive: true, force: true });
    }
  });

  it("pins one checksummed release per platform from each driver's publisher", () => {
    const { darwin, win32, linux } = SCREEN_DRIVER_RELEASES;
    expect(darwin.url).toMatch(
      /^https:\/\/github\.com\/trycua\/cua\/releases\/download\/cua-driver-rs-v[\d.]+\/cua-driver-rs-[\d.]+-darwin-universal-binary\.tar\.gz$/,
    );
    expect(win32.url).toMatch(
      /^https:\/\/github\.com\/vercel-labs\/agent-desktop\/releases\/download\/v([\d.]+)\/agent-desktop-v\1-x86_64-pc-windows-msvc\.tar\.gz$/,
    );
    expect(linux.url).toMatch(
      /^https:\/\/github\.com\/vercel-labs\/agent-desktop\/releases\/download\/v([\d.]+)\/agent-desktop-v\1-x86_64-unknown-linux-gnu\.tar\.gz$/,
    );
    // One agent-desktop version on every platform, so the adapter reads one CLI.
    expect(linux.url.split("/download/")[1]!.split("/")[0]).toBe(
      win32.url.split("/download/")[1]!.split("/")[0],
    );
    for (const release of [darwin, win32, linux]) {
      expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(release.driverSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
