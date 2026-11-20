import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppAccessibility, inspectApp } from "./app-accessibility.js";
import { launcherDirs } from "./launcher-override.js";
import type { UserProcess } from "./processes.js";

const FALLBACK = "browser is open but doesn't share its window with screen control.";

/** A browser started by its launcher's script, with the engine's helper processes. */
const browser = (mainArgs: string[] = []): UserProcess[] => [
  { pid: 1, ppid: 0, comm: "systemd", exe: "/usr/lib/systemd/systemd", argv: ["systemd"] },
  {
    pid: 20,
    ppid: 1,
    comm: "web-browser",
    exe: "/usr/bin/bash",
    argv: ["/bin/bash", "/opt/web/web-browser", "--ozone-platform=wayland"],
  },
  {
    pid: 21,
    ppid: 20,
    comm: "browser",
    exe: "/opt/web/browser",
    argv: ["/opt/web/browser", "--ozone-platform=wayland", ...mainArgs],
  },
  {
    pid: 22,
    ppid: 21,
    comm: "browser",
    exe: "/opt/web/browser",
    argv: ["/opt/web/browser", "--type=zygote"],
  },
];

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function setup(processes: UserProcess[], selfPid = 99) {
  root = await mkdtemp(path.join(tmpdir(), "app-access-"));
  const system = path.join(root, "usr", "applications");
  await mkdir(system, { recursive: true });
  await writeFile(
    path.join(system, "web-browser.desktop"),
    "[Desktop Entry]\nName=Web Browser\nExec=web-browser %U\n",
  );
  // A web app the browser made lives in the user's folder and runs the browser's script too.
  const dirs = {
    ...launcherDirs({ XDG_DATA_HOME: path.join(root, "share") }, "/unused"),
    system: [system],
  };
  await mkdir(dirs.user, { recursive: true });
  await writeFile(
    path.join(dirs.user, "web-browser-app.desktop"),
    "[Desktop Entry]\nName=Mail\nExec=/opt/web/web-browser --app-id=mail\n",
  );
  const answer = deferred<boolean>();
  const ask = vi.fn(() => answer.promise);
  const failed = vi.fn();
  const access = createAppAccessibility({
    dirs,
    processes: async () => processes,
    selfPid,
    ask,
    failed,
  });
  return { access, dirs, answer, ask, failed };
}

// The launchers are a Linux desktop's; their scripts need a POSIX shell.
describe.skipIf(process.platform === "win32")("app accessibility", () => {
  it("reads how an app was started and whether it runs on the engine", () => {
    expect(inspectApp("browser", browser(), 99)).toEqual({
      self: false,
      engine: true,
      sharing: false,
      launchers: ["browser", "web-browser"],
    });
    expect(inspectApp("browser", browser(["--force-renderer-accessibility"]), 99)).toMatchObject({
      sharing: true,
    });
    expect(inspectApp("browser", browser().slice(0, 3), 99)).toMatchObject({ engine: false });
    expect(inspectApp("missing", browser(), 99)).toBeUndefined();
    // An app on a shared runtime: its launcher script hands over, and only its archive names it.
    const runtime = (args: string[]): UserProcess => ({
      pid: 30 + args.length,
      ppid: args.length === 1 ? 1 : 31,
      comm: "electron",
      exe: "/usr/lib/electron/electron",
      argv: ["/usr/lib/electron/electron", ...args],
    });
    expect(
      inspectApp(
        "notes",
        [runtime(["/usr/lib/notes/app.asar"]), runtime(["--type=zygote", "--x"])],
        99,
      ),
    ).toEqual({
      self: false,
      engine: true,
      sharing: false,
      launchers: ["notes"],
    });
  });

  it("asks once, then sets up the system entry's launcher when the user allows it", async () => {
    const { access, dirs, answer, ask } = await setup(browser());
    const message = await access.explain("browser", FALLBACK);
    expect(message).toBe(
      "Rakazo is asking the user on their computer whether bots may use Web Browser. Ask them to answer it; if they allow it, they then need to quit Web Browser completely and open it again.",
    );
    await access.explain("browser", FALLBACK);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith("Web Browser");
    answer.resolve(true);
    await vi.waitFor(async () =>
      expect(await readFile(path.join(dirs.user, "web-browser.desktop"), "utf8")).toContain(
        "X-Rakazo-Launcher=",
      ),
    );
    expect(await access.explain("browser", FALLBACK)).toBe(
      "Web Browser is set up for screen control but is still running from before. Ask the user to quit Web Browser completely and open it again.",
    );
  });

  it("asks for an app started with only the option, and tells apart one Rakazo's launcher started", async () => {
    const { access, dirs, answer, ask } = await setup(browser(["--force-renderer-accessibility"]));
    await access.explain("browser", FALLBACK);
    expect(ask).toHaveBeenCalledTimes(1);
    answer.resolve(true);
    await vi.waitFor(async () =>
      expect(await readFile(path.join(dirs.user, "web-browser.desktop"), "utf8")).toContain(
        "X-Rakazo-Launcher=",
      ),
    );
    expect(await access.explain("browser", FALLBACK)).toBe(
      "Web Browser was started for screen control but still doesn't share its window. Ask the user to quit Web Browser completely and open it again from their app launcher.",
    );
  });

  it("keeps an entry the user made while the question was open", async () => {
    const { access, dirs, answer } = await setup(browser());
    await access.explain("browser", FALLBACK);
    const mine = "[Desktop Entry]\nName=Web Browser\nExec=web-browser --mine %U\n";
    await writeFile(path.join(dirs.user, "web-browser.desktop"), mine);
    answer.resolve(true);
    await vi.waitFor(async () =>
      expect(await access.explain("browser", FALLBACK)).toMatch(/launcher entry the user made/),
    );
    expect(await readFile(path.join(dirs.user, "web-browser.desktop"), "utf8")).toBe(mine);
  });

  it("asks nothing for an app its launcher starts over D-Bus, which skips the script", async () => {
    const { access, dirs, ask } = await setup(browser());
    await writeFile(
      path.join(dirs.system[0]!, "web-browser.desktop"),
      "[Desktop Entry]\nName=Web Browser\nExec=web-browser %U\nDBusActivatable=true\n",
    );
    expect(await access.explain("browser", FALLBACK)).toBe(FALLBACK);
    expect(ask).not.toHaveBeenCalled();
  });

  it("doesn't ask again after Not Now until Rakazo restarts", async () => {
    const { access, answer, ask } = await setup(browser());
    await access.explain("browser", FALLBACK);
    answer.resolve(false);
    await vi.waitFor(async () =>
      expect(await access.explain("browser", FALLBACK)).toBe(
        "The user chose not to set Web Browser up for screen control for now.",
      ),
    );
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("tells the user when a change they allowed couldn't be made", async () => {
    const { access, dirs, answer, failed } = await setup(browser());
    // A file where the scripts' folder goes stops the script from being written.
    await writeFile(path.dirname(dirs.scripts), "not a folder");
    await access.explain("browser", FALLBACK);
    answer.resolve(true);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith("Web Browser", expect.any(Error)));
  });

  it("leaves the user's own entry alone and says how to change it", async () => {
    const { access, dirs, ask } = await setup(browser());
    await writeFile(
      path.join(dirs.user, "web-browser.desktop"),
      "[Desktop Entry]\nName=Web Browser\nExec=web-browser --mine %U\n",
    );
    expect(await access.explain("browser", FALLBACK)).toMatch(
      /^Web Browser has a launcher entry the user made, so Rakazo leaves it alone\./,
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks nothing for an app it can't help with", async () => {
    const plain = browser().slice(0, 3);
    for (const [processes, selfPid, expected] of [
      [plain, 99, FALLBACK],
      [browser(), 21, "Rakazo can't use its own window."],
    ] as const) {
      const { access, ask } = await setup([...processes], selfPid);
      expect(await access.explain("browser", FALLBACK)).toBe(expected);
      expect(ask).not.toHaveBeenCalled();
      await rm(root!, { recursive: true, force: true });
    }
  });

  it("finds an app by the name of its launcher entry", async () => {
    const { access } = await setup([]);
    expect(await access.aliases("Web Browser")).toEqual(["web-browser"]);
    expect(await access.aliases("Mail")).toEqual(["web-browser"]);
  });
});
