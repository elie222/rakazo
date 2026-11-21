import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readDesktopEntries } from "./desktop-entries.js";
import type { LauncherDirs } from "./launcher-override.js";
import {
  canWriteLauncher,
  launcherDirs,
  launcherOwner,
  refreshLaunchers,
  removeLaunchers,
  writeLauncher,
} from "./launcher-override.js";

const BROWSER = [
  "[Desktop Entry]",
  "Name=Web Browser",
  "Exec=web-browser %U",
  "Actions=new-window;private;",
  "",
  "[Desktop Action new-window]",
  "Exec=web-browser",
  "",
  "[Desktop Action private]",
  "Exec=web-browser --incognito",
  "",
].join("\n");

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function setup(): Promise<LauncherDirs> {
  root = await mkdtemp(path.join(tmpdir(), "launchers-"));
  const dirs = launcherDirs({ XDG_DATA_HOME: path.join(root, "share") }, "/unused");
  const system = path.join(root, "usr", "applications");
  await mkdir(system, { recursive: true });
  await writeFile(path.join(system, "web-browser.desktop"), BROWSER);
  return { ...dirs, system: [system] };
}

async function systemEntry(dirs: LauncherDirs) {
  const [entry] = await readDesktopEntries(dirs.system);
  if (!entry) throw new Error("no system entry");
  return entry;
}

// The launchers are a Linux desktop's; their scripts need a POSIX shell.
describe.skipIf(process.platform === "win32")("launcher overrides", () => {
  it("hides the system entry behind one that starts the app through a marked script", async () => {
    const dirs = await setup();
    await writeLauncher(await systemEntry(dirs), dirs);
    const script = path.join(dirs.scripts, "web-browser", "web-browser");
    const text = await readFile(path.join(dirs.user, "web-browser.desktop"), "utf8");
    expect(text).toMatch(/^\[Desktop Entry\]\nX-Rakazo-Launcher=[0-9a-f]{64}\n/);
    expect(text).toContain(`\nExec=${script} %U\n`);
    expect(text).toContain(`\nExec=${script}\n`);
    expect(text).toContain(`\nExec=${script} --incognito\n`);
    expect((await stat(script)).mode & 0o777).toBe(0o755);
    expect(await launcherOwner("web-browser.desktop", dirs)).toBe("rakazo");
  });

  it("starts the app with the variable and the option, passing its own arguments on", async () => {
    const dirs = await setup();
    const program = path.join(root!, "bin", "web-browser");
    await mkdir(path.dirname(program));
    await writeFile(program, '#!/bin/sh\necho "$ACCESSIBILITY_ENABLED" "$@"\n', { mode: 0o755 });
    const entry = await systemEntry(dirs);
    await writeFile(entry.file, BROWSER.replaceAll("Exec=web-browser", `Exec=${program}`));
    await writeLauncher(await systemEntry(dirs), dirs);
    const { stdout } = await promisify(execFile)(
      path.join(dirs.scripts, "web-browser", "web-browser"),
      ["https://example.com/a b"],
    );
    expect(stdout).toBe("1 --force-renderer-accessibility https://example.com/a b\n");
  });

  it("leaves an entry the user wrote alone, and removes only Rakazo's", async () => {
    const dirs = await setup();
    await mkdir(dirs.user, { recursive: true });
    await writeFile(path.join(dirs.user, "web-browser.desktop"), BROWSER);
    expect(await launcherOwner("web-browser.desktop", dirs)).toBe("user");
    await writeFile(path.join(dirs.user, "other.desktop"), "[Desktop Entry]\nExec=other\n");
    await removeLaunchers(dirs);
    expect((await readdir(dirs.user)).sort()).toEqual(["other.desktop", "web-browser.desktop"]);

    await rm(path.join(dirs.user, "web-browser.desktop"));
    await writeLauncher(await systemEntry(dirs), dirs);
    await removeLaunchers(dirs);
    expect(await readdir(dirs.user)).toEqual(["other.desktop"]);
    await expect(stat(path.dirname(dirs.scripts))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await launcherOwner("web-browser.desktop", dirs)).toBeUndefined();
  });

  it("removes an entry whose app update starts a different program, rather than carry the consent over", async () => {
    const dirs = await setup();
    const entry = await systemEntry(dirs);
    await writeLauncher(entry, dirs);
    await writeFile(entry.file, BROWSER.replaceAll("Exec=web-browser", "Exec=other-browser"));
    await refreshLaunchers(dirs);
    expect(await readdir(dirs.user)).toEqual([]);
  });

  it("never removes a folder outside the scripts' own for a strangely named entry", async () => {
    const dirs = await setup();
    await mkdir(dirs.user, { recursive: true });
    const kept = path.join(path.dirname(dirs.scripts), "kept");
    await mkdir(kept, { recursive: true });
    await writeFile(path.join(dirs.user, "...desktop"), "[Desktop Entry]\nX-Rakazo-Launcher=0\n");
    await removeLaunchers(dirs);
    expect(await readdir(path.dirname(dirs.scripts))).toEqual(["kept"]);
  });

  it("writes only entries a script can start: its own program, a plain path, and no D-Bus start", async () => {
    const dirs = await setup();
    const entry = await systemEntry(dirs);
    expect(canWriteLauncher(entry, dirs)).toBe(true);
    const dbus = { ...entry, keys: new Map([...entry.keys, ["DBusActivatable", "true"]]) };
    expect(canWriteLauncher(dbus, dirs)).toBe(false);
    expect(canWriteLauncher(entry, { ...dirs, scripts: "/home/a b/launchers" })).toBe(false);
    expect(canWriteLauncher({ ...entry, id: "my app.desktop" }, dirs)).toBe(false);
    await expect(
      writeLauncher(entry, { ...dirs, scripts: "/home/a b/launchers" }),
    ).rejects.toThrow();
  });

  it("follows an app update that changes its entry, and an uninstall that removes it", async () => {
    const dirs = await setup();
    const entry = await systemEntry(dirs);
    await writeLauncher(entry, dirs);
    await writeFile(entry.file, BROWSER.replace("Name=Web Browser", "Name=Web Browser 2"));
    await refreshLaunchers(dirs);
    const text = await readFile(path.join(dirs.user, "web-browser.desktop"), "utf8");
    expect(text).toContain("Name=Web Browser 2");
    expect(text).toContain(path.join(dirs.scripts, "web-browser", "web-browser"));

    await rm(entry.file);
    await refreshLaunchers(dirs);
    expect(await readdir(dirs.user)).toEqual([]);
    expect(await readdir(dirs.scripts)).toEqual([]);
  });
});
