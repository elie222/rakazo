import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applicationDirs,
  entryPrograms,
  execProgram,
  readDesktopEntries,
  withExecProgram,
} from "./desktop-entries.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("desktop entries", () => {
  it("reads the program an Exec line runs, quoted or not", () => {
    expect(execProgram("web-browser %U")).toBe("web-browser");
    expect(execProgram('"/opt/My App/app" --flag %F')).toBe("/opt/My App/app");
    expect(execProgram('"/opt/say \\"hi\\"/app"')).toBe('/opt/say "hi"/app');
    // Another program starts the app, so changing how that program starts wouldn't reach it.
    expect(execProgram("env GDK_BACKEND=x11 app %U")).toBeUndefined();
    expect(execProgram("flatpak run org.example.App")).toBeUndefined();
    expect(execProgram("VAR=1 app")).toBeUndefined();
    expect(execProgram("")).toBeUndefined();
  });

  it("swaps the program and keeps the arguments and field codes", () => {
    expect(withExecProgram("web-browser --incognito %U", "/home/u/run/web-browser")).toBe(
      "/home/u/run/web-browser --incognito %U",
    );
    expect(withExecProgram('"/opt/My App/app" %F', "/home/a b/app")).toBe('"/home/a b/app" %F');
  });

  it("finds entries in the user's folder before the system's, and the programs named ones run", async () => {
    root = await mkdtemp(path.join(tmpdir(), "entries-"));
    const dirs = applicationDirs({ XDG_DATA_HOME: path.join(root, "home") }, "/unused");
    const system = path.join(root, "usr", "applications");
    await mkdir(dirs.user, { recursive: true });
    await mkdir(system, { recursive: true });
    await writeFile(
      path.join(system, "org.example.Files.desktop"),
      "[Desktop Entry]\nName=Files\nExec=file-manager --new-window %U\n[Desktop Action new]\nName=New\nExec=other\n",
    );
    await writeFile(
      path.join(system, "web-browser.desktop"),
      "[Desktop Entry]\nName=Web Browser\nStartupWMClass=WebBrowser\nExec=web-browser %U\n",
    );
    await writeFile(
      path.join(dirs.user, "web-browser.desktop"),
      "[Desktop Entry]\nName=My Browser\nExec=my-browser %U\n",
    );
    const entries = await readDesktopEntries([dirs.user, system, path.join(root, "missing")]);
    expect(entries.map((entry) => entry.file)).toEqual([
      path.join(dirs.user, "web-browser.desktop"),
      path.join(system, "org.example.Files.desktop"),
    ]);
    expect(entryPrograms("files", entries)).toEqual(["file-manager"]);
    expect(entryPrograms("org.example.Files", entries)).toEqual(["file-manager"]);
    expect(entryPrograms("My Browser", entries)).toEqual(["my-browser"]);
    expect(entryPrograms("New", entries)).toEqual([]);
    // An app archive on a shared runtime is named by its folder, not by the runtime.
    await writeFile(
      path.join(system, "notes.desktop"),
      "[Desktop Entry]\nName=Notes\nExec=electron /usr/lib/notes-app/app.asar %U\n",
    );
    const more = await readDesktopEntries([system]);
    expect(entryPrograms("Notes", more)).toEqual(["notes-app"]);
  });
});
