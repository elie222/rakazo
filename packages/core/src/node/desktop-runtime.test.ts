import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DESKTOP_ENV,
  desktopControlCommand,
  desktopUrl,
  ensureScreenCommand,
  interactiveScreenCommand,
  managedDesktopCommand,
  releaseDesktopCommand,
  screenPorts,
  shellQuote,
  stopExtraScreenCommand,
} from "./desktop-runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const env = {
  homeDir: "/home/user",
  workspaceDir: "/home/user/work",
  browserProfilesDir: "/home/user/work/.browser-profiles",
  displayStart: 20,
  portStart: 6100,
  vncPortStart: 5920,
};

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "desktop-runtime-test-"));
  roots.push(root);
  const run = (script: string, failLifecycle = false) =>
    spawnSync(
      "bash",
      [
        "-eu",
        "-c",
        [
          // Lifecycle processes are stubbed here; the opt-in Docker smoke runs the real commands.
          "flock() { :; }",
          `bash() { return ${failLifecycle ? 1 : 0}; }`,
          script.replaceAll("/tmp/rakazo/desktop-assignments", root),
        ].join("\n"),
      ],
      { encoding: "utf8", timeout: 5000 },
    );
  const ensure = (bot: string, lease = "run:1", fail = false) =>
    run(managedDesktopCommand(bot, lease, env, `view-${bot}`), fail);
  const release = (bot: string, lease = "run:1", fail = false) =>
    run(releaseDesktopCommand(bot, lease, env), fail);
  return { root, run, ensure, release };
}

describe("shared Linux desktop lifecycle", () => {
  it("allocates bounded live slots, keeps assignments across callers, and rejects stale leases", () => {
    const f = fixture();
    expect(f.ensure("a").stdout).toContain("RAKAZO_DESKTOP=0:view-a");
    expect(f.ensure("b").stdout).toContain("RAKAZO_DESKTOP=1:view-b");
    expect(f.ensure("a", "new:2").stdout).toContain("RAKAZO_DESKTOP=0:view-a");
    expect(f.ensure("a", "run:1").status).toBe(75);
    expect(f.release("a", "run:3").status).toBe(75);
    expect(f.release("a", "new:1").status).toBe(75);
    for (let i = 2; i < 8; i++) expect(f.ensure(`bot-${i}`).status).toBe(0);
    expect(f.ensure("overflow").status).toBe(75);
    expect(f.release("a", "new:2").status).toBe(0);
    expect(f.ensure("c").stdout).toContain("RAKAZO_DESKTOP=0:view-c");
    expect(f.ensure("b").stdout).toContain("RAKAZO_DESKTOP=1:view-b");
  });

  it("reserves failed startup and teardown slots until a successful retry", () => {
    const f = fixture();
    expect(f.ensure("a", "run:1", true).status).toBe(1);
    expect(f.ensure("b").stdout).toContain("RAKAZO_DESKTOP=1:view-b");
    expect(f.ensure("a").stdout).toContain("RAKAZO_DESKTOP=0:view-a");
    expect(f.release("a", "run:1", true).status).toBe(1);
    expect(f.ensure("c").stdout).toContain("RAKAZO_DESKTOP=2:view-c");
    expect(f.release("a").status).toBe(0);
    expect(f.ensure("d").stdout).toContain("RAKAZO_DESKTOP=0:view-d");
  });

  it("does not create a screen on control release and keeps newer fences", () => {
    const f = fixture();
    expect(f.run(desktopControlCommand("missing", "run:1", env, false, "token")).status).toBe(0);
    expect(readdirSync(f.root).filter((name) => name.endsWith(".slot"))).toEqual([]);
    expect(f.ensure("a", "new:2").status).toBe(0);
    expect(f.run(desktopControlCommand("a", "old:1", env, true, "token")).status).toBe(75);
    const slot = readdirSync(f.root).find((name) => name.endsWith(".slot"))!;
    expect(readFileSync(path.join(f.root, slot), "utf8")).toContain("new:2");
  });

  it.each([DEFAULT_DESKTOP_ENV, env])(
    "generates valid shell for every lifecycle operation ($displayStart)",
    (environment) => {
      for (const command of [
        ensureScreenCommand(0, "bot's id", "token", environment),
        ensureScreenCommand(1, "bot's id", "token", environment),
        managedDesktopCommand("bot's id", "run:1", environment, "token"),
        releaseDesktopCommand("bot's id", "run:1", environment),
        desktopControlCommand("bot's id", "run:1", environment, true, "token"),
        interactiveScreenCommand(false, "token", screenPorts(1, environment)),
        stopExtraScreenCommand(1, "bot's id", environment),
      ]) {
        const result = spawnSync("bash", ["-n", "-c", command], { encoding: "utf8" });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      }
    },
  );

  it("matches only the selected transport executable, including remote websockify paths", () => {
    const command = stopExtraScreenCommand(1, "a", env);
    const patterns = [...command.matchAll(/pkill -f '([^']+)'/g)].map(
      (match) => new RegExp(match[1]!),
    );
    for (const pattern of patterns) {
      expect(`/bin/bash -c ${shellQuote(command)}`).not.toMatch(pattern);
      expect(
        "/usr/bin/python3 /usr/local/bin/websockify --web=/opt/noVNC 0.0.0.0:6100",
      ).not.toMatch(pattern);
    }
    expect(
      patterns.some((pattern) =>
        pattern.test("/usr/bin/python3 /usr/local/bin/websockify --web=/opt/noVNC 0.0.0.0:6102"),
      ),
    ).toBe(true);
  });

  it("keeps provider authentication while adding the per-lease websocket capability", () => {
    const url = new URL(
      desktopUrl("https://desktop.test/vnc.html?_token=provider-key", "view-key"),
    );
    expect(url.searchParams.get("_token")).toBe("provider-key");
    expect(url.searchParams.get("path")).toBe("websockify?_token=provider-key&token=view-key");
  });
});
