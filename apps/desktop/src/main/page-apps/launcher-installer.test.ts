import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageAppLauncher } from "./launcher-installer.js";
import { createLauncherInstaller } from "./launcher-installer.js";
import { pageAppDataDir, pageAppsDataDir } from "./page-app-files.js";
import type { InstalledPageApp } from "./registry.js";

const TOKEN = `rkpa_${"a".repeat(43)}`;
const SERVER = "https://rakazo.example.com";

let appData: string;
let apps: InstalledPageApp[];
const registry = {
  list: async () => apps,
  put: async (app: InstalledPageApp) => {
    apps = [...apps.filter((each) => each.appId !== app.appId), app];
  },
  remove: async (appId: string) => {
    apps = apps.filter((each) => each.appId !== appId);
  },
};

beforeEach(async () => {
  appData = await mkdtemp(path.join(tmpdir(), "rakazo-launchers-"));
  apps = [];
});
afterEach(async () => {
  await rm(appData, { recursive: true, force: true });
});

function setup(write?: PageAppLauncher["write"]) {
  const launcher: PageAppLauncher = {
    write:
      write ??
      (async ({ config }) => {
        const shortcut = path.join(appData, `${config.appId}.lnk`);
        await writeFile(shortcut, "");
        return shortcut;
      }),
    repoint: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    find: async (appId) => {
      const name = (await readdir(appData)).find(
        (file) => file.startsWith(appId) && file.endsWith(".lnk"),
      );
      return name ? path.join(appData, name) : null;
    },
  };
  const open = vi.fn(async () => undefined);
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  const installer = createLauncherInstaller({ registry, launcher, open, appData, fetch });
  return { installer, launcher, open, fetch };
}

const request = (appId: string) => ({
  appId,
  pageId: "page1",
  title: "Deals",
  token: TOKEN,
  icon: new Map([[256, Buffer.from("png")]]),
});

describe("createLauncherInstaller", () => {
  it("keeps the app's config and private token in its data folder, then starts it", async () => {
    const { installer, open } = setup();
    await installer.install(request("app1"), SERVER);
    const dataDir = pageAppDataDir("app1", appData);
    expect(JSON.parse(await readFile(path.join(dataDir, "page-app.json"), "utf8"))).toEqual({
      appId: "app1",
      pageId: "page1",
      title: "Deals",
      server: SERVER,
    });
    expect(await readFile(path.join(dataDir, "token"), "utf8")).toBe(TOKEN);
    if (process.platform !== "win32")
      expect((await stat(path.join(dataDir, "token"))).mode & 0o777).toBe(0o600);
    expect(apps.map((app) => app.bundlePath)).toEqual([path.join(appData, "app1.lnk")]);
    expect(open).toHaveBeenCalledWith("app1");
  });

  it("leaves nothing behind when the launcher cannot be written", async () => {
    const { installer } = setup(async () => {
      throw new Error("no shortcut");
    });
    await expect(installer.install(request("app1"), SERVER)).rejects.toThrow("no shortcut");
    expect(existsSync(pageAppDataDir("app1", appData))).toBe(false);
    expect(apps).toEqual([]);
  });

  it("removes the launcher and data and revokes the token on uninstall", async () => {
    const { installer, launcher, fetch } = setup();
    await installer.install(request("app1"), SERVER);
    expect(await installer.uninstall("app1")).toBe(true);
    expect(launcher.remove).toHaveBeenCalledWith(path.join(appData, "app1.lnk"));
    const [url, init] = fetch.mock.calls.at(-1) as unknown as [URL, RequestInit];
    expect([String(url), init.method]).toEqual([`${SERVER}/api/v1/page-app`, "DELETE"]);
    expect(existsSync(pageAppDataDir("app1", appData))).toBe(false);
    expect(apps).toEqual([]);
  });

  it("clears data a removed app left behind, never an installed app's", async () => {
    const { installer } = setup();
    await installer.install(request("app1"), SERVER);
    const left = pageAppDataDir("gone1", appData);
    await mkdir(left, { recursive: true });
    await writeFile(path.join(left, "Cookies"), "");
    await installer.refresh();
    expect(existsSync(left)).toBe(false);
    expect(existsSync(pageAppDataDir("app1", appData))).toBe(true);
    expect(existsSync(pageAppsDataDir(appData))).toBe(true);
  });

  it("revokes an app whose launcher was deleted, and keeps it while the revoke fails", async () => {
    const { installer, fetch } = setup();
    await installer.install(request("app1"), SERVER);
    await rm(path.join(appData, "app1.lnk"));
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await installer.refresh();
    expect(apps.map((app) => app.appId)).toEqual(["app1"]);
    await installer.refresh();
    expect(fetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ href: expect.stringContaining("/api/v1/page-app") }),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(apps).toEqual([]);
  });

  it("follows a launcher the person renamed instead of removing its app", async () => {
    const { installer, fetch } = setup();
    await installer.install(request("app1"), SERVER);
    await rename(path.join(appData, "app1.lnk"), path.join(appData, "app1 renamed.lnk"));
    await installer.refresh();
    expect(apps).toEqual([
      expect.objectContaining({ bundlePath: path.join(appData, "app1 renamed.lnk") }),
    ]);
    expect(fetch).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("takes back an installed app whose record was lost", async () => {
    const { installer } = setup();
    await installer.install(request("app1"), SERVER);
    apps = [];
    await installer.refresh();
    expect(apps).toEqual([
      expect.objectContaining({ appId: "app1", bundlePath: path.join(appData, "app1.lnk") }),
    ]);
  });

  it("drops the launcher of an app whose record and config were both lost", async () => {
    const { installer, launcher } = setup();
    await installer.install(request("app1"), SERVER);
    apps = [];
    await rm(path.join(pageAppDataDir("app1", appData), "page-app.json"));
    await installer.refresh();
    expect(launcher.remove).toHaveBeenCalledWith(path.join(appData, "app1.lnk"));
    expect(existsSync(pageAppDataDir("app1", appData))).toBe(false);
  });

  it("restores an app's lost config from its record", async () => {
    const { installer } = setup();
    await installer.install(request("app1"), SERVER);
    const config = path.join(pageAppDataDir("app1", appData), "page-app.json");
    await rm(config);
    await installer.refresh();
    expect(JSON.parse(await readFile(config, "utf8"))).toMatchObject({
      appId: "app1",
      server: SERVER,
    });
    expect(apps.map((app) => app.appId)).toEqual(["app1"]);
  });

  it("drops a launcher left behind by an app that removed itself", async () => {
    const { installer, launcher } = setup();
    await installer.install(request("app1"), SERVER);
    await rm(pageAppDataDir("app1", appData), { recursive: true });
    await installer.refresh();
    expect(launcher.remove).toHaveBeenCalledWith(path.join(appData, "app1.lnk"));
    expect(apps).toEqual([]);
  });

  it("forgets an app that uninstalled itself and clears what it left", async () => {
    const { installer } = setup();
    await installer.install(request("app1"), SERVER);
    const dataDir = pageAppDataDir("app1", appData);
    await rm(path.join(appData, "app1.lnk"));
    await rm(path.join(dataDir, "token"));
    await writeFile(path.join(dataDir, "Cookies"), "");
    await installer.refresh();
    expect(apps).toEqual([]);
    expect(existsSync(dataDir)).toBe(false);
  });
});
