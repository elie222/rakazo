import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserCloseProgram,
  DEFAULT_DESKTOP_ENV,
  desktopControlCommand,
  desktopUrl,
  ensureScreenCommand,
  interactiveScreenCommand,
  MAX_DESKTOP_DISPLAY,
  managedDesktopCommand,
  quiesceBrowserProfilesCommand,
  releaseDesktopCommand,
  resetDesktopRuntimeCommand,
  screenPorts,
  shellQuote,
  stopExtraScreenCommand,
} from "./desktop-runtime.js";

const JOINED_COMMAND = `import os, time
raw = open("/proc/self/cmdline", "rb").read().rstrip(b"\\0")
joined = raw.replace(b"\\0", b" ")
start = end = None
for line in open("/proc/self/maps"):
    if "[stack]" in line:
        a, b = line.split()[0].split("-")
        start, end = int(a, 16), int(b, 16)
        break
mem = os.open("/proc/self/mem", os.O_RDWR)
pos = end
found = None
while pos > start:
    size = min(1024 * 1024, pos - start)
    pos -= size
    os.lseek(mem, pos, os.SEEK_SET)
    data = os.read(mem, size + len(raw))
    idx = data.find(raw)
    if idx != -1:
        found = pos + idx
        break
if found is None:
    raise SystemExit("cmdline not found")
os.lseek(mem, found, os.SEEK_SET)
os.write(mem, joined)
os.close(mem)
open(os.environ["JOINED_READY"], "w").write("ready\\n")
time.sleep(120)
`;

function waitForReady(file: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (spawnSync("test", ["-s", file]).status === 0) return;
    spawnSync("sleep", ["0.02"]);
  }
  throw new Error("space-joined command line was not published");
}

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
          script
            .replaceAll("/tmp/rakazo/desktop-assignments", root)
            .replaceAll("/tmp/rakazo", root),
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
  it("allocates live slots past 1000 bots, keeps assignments across callers, and rejects stale leases", () => {
    const f = fixture();
    expect(f.ensure("a").stdout).toContain("RAKAZO_DESKTOP=0:view-a");
    expect(f.ensure("b").stdout).toContain("RAKAZO_DESKTOP=1:view-b");
    expect(f.ensure("a", "new:2").stdout).toContain("RAKAZO_DESKTOP=0:view-a");
    expect(f.ensure("a", "run:1").status).toBe(75);
    expect(f.release("a", "run:3").status).toBe(75);
    expect(f.release("a", "new:1").status).toBe(75);
    for (let i = 2; i < 1000; i++)
      writeFileSync(path.join(f.root, `seed-${i}.slot`), `${i}\nseed:1\nunused\n`);
    expect(f.ensure("bot-1000").stdout).toContain("RAKAZO_DESKTOP=1000:view-bot-1000");
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

  it("skips damaged assignments while reserving their live display markers", () => {
    const f = fixture();
    writeFileSync(path.join(f.root, "empty.slot"), "");
    writeFileSync(path.join(f.root, "invalid.slot"), "broken\nlease:1\ntoken\n");
    writeFileSync(
      path.join(f.root, "browser-profile-20"),
      "/home/user/work/.browser-profiles/live",
    );
    expect(f.ensure("a").stdout).toContain("RAKAZO_DESKTOP=1:view-a");
    expect(f.ensure("b").stdout).toContain("RAKAZO_DESKTOP=2:view-b");
    expect(f.ensure("a").stdout).toContain("RAKAZO_DESKTOP=1:view-a");
  });

  it("continues resetting valid displays after invalid or out-of-range markers", () => {
    const f = fixture();
    for (const display of ["019", "19", "20", "22", "99999", "invalid"])
      writeFileSync(path.join(f.root, `browser-profile-${display}`), "fixture");
    const record = path.join(f.root, "stopped");
    const result = spawnSync(
      "bash",
      [
        "-eu",
        "-c",
        [
          "pkill() { :; }; sleep() { :; }",
          `bash() { printf '%s\\n' "$5" >>${shellQuote(record)}; }`,
          resetDesktopRuntimeCommand(env).replaceAll("/tmp/rakazo", f.root),
        ].join("\n"),
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(record, "utf8")).toBe("0\n2\n");
  });

  it("stops only the selected VNC transport and keeps the shared gateway", () => {
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
        pattern.test(
          "/usr/bin/x11vnc -display :21 -rfbport 0 -unixsock /tmp/rakazo/sockets/view-21-token -forever",
        ),
      ),
    ).toBe(true);
  });

  it("uses one published gateway and distinct private ports across 1000 desktops", () => {
    const ports = new Set<number>();
    for (let index = 0; index < 1000; index++) {
      const layout = screenPorts(index, env);
      expect(layout.viewPort).toBe("6100");
      expect(layout.controlPort).toBe("6100");
      expect(ports.has(layout.debugPort)).toBe(false);
      ports.add(layout.debugPort);
    }
    expect(screenPorts(MAX_DESKTOP_DISPLAY - env.displayStart, env).debugPort).toBeLessThanOrEqual(
      65535,
    );
    for (const index of [-1, 0.5, Number.POSITIVE_INFINITY, MAX_DESKTOP_DISPLAY]) {
      expect(() => screenPorts(index, env)).toThrow("invalid desktop index");
    }
  });

  it.skipIf(process.platform !== "linux")(
    "quiesces the debugger-owning Chromium process and keeps cookie databases",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "desktop-quiesce-"));
      roots.push(root);
      const home = path.join(root, "home");
      const profiles = path.join(home, "team --type=renderer archive");
      const bin = path.join(root, "bin");
      const log = path.join(root, "closed");
      mkdirSync(bin);
      const sleeper = path.join(bin, "sleeper");
      writeFileSync(sleeper, "#!/bin/sh\nsleep 120\n");
      chmodSync(sleeper, 0o755);
      writeFileSync(
        path.join(bin, "python3"),
        [
          "#!/bin/sh",
          'pid=""',
          'for arg in "$@"; do',
          '  case "$arg" in',
          "    ''|*[!0-9]*) ;;",
          "    *) pid=$arg ;;",
          "  esac",
          "done",
          'if [ -n "$pid" ]; then',
          '  printf "%s\\n" "$pid" >> "$QUIESCE_LOG"',
          '  kill "$pid" 2>/dev/null || true',
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(path.join(bin, "python3"), 0o755);
      const children: ChildProcess[] = [];
      const start = (directory: string, args: string[]) => {
        const cookies = path.join(directory, "Default", "Network", "Cookies");
        mkdirSync(path.dirname(cookies), { recursive: true });
        writeFileSync(cookies, "session=kept");
        const child = spawn(sleeper, args, {
          stdio: "ignore",
          detached: true,
        });
        children.push(child);
        return { child, cookies };
      };
      const botDir = path.join(profiles, "chromium-bot-abc");
      const primaryDir = path.join(profiles, "chromium");
      const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
      }).stdout.trim();
      const joiner = path.join(bin, "join-cmdline.py");
      writeFileSync(joiner, JOINED_COMMAND);
      const joinedDir = path.join(profiles, "chromium-screen-4");
      const joinedReady = path.join(root, "joined-ready");
      const joinedCookies = path.join(joinedDir, "Default", "Network", "Cookies");
      mkdirSync(path.dirname(joinedCookies), { recursive: true });
      writeFileSync(joinedCookies, "session=kept");
      const joined = spawn(
        python,
        [joiner, `--user-data-dir=${joinedDir}`, "--remote-debugging-port=9335"],
        { stdio: "ignore", detached: true, env: { ...process.env, JOINED_READY: joinedReady } },
      );
      children.push(joined);
      const bot = start(botDir, [`--user-data-dir=${botDir}`, "--remote-debugging-port=9333"]);
      const botRenderer = start(botDir, [
        "--type=renderer",
        `--user-data-dir=${botDir}`,
        "--remote-debugging-port=9333",
      ]);
      const botHelper = start(botDir, [`--user-data-dir=${botDir}`]);
      const primary = start(primaryDir, [
        `--user-data-dir=${primaryDir}`,
        "--remote-debugging-port=9334",
      ]);
      try {
        const command = quiesceBrowserProfilesCommand({
          ...DEFAULT_DESKTOP_ENV,
          homeDir: home,
          workspaceDir: home,
          browserProfilesDir: profiles,
        }).replaceAll("/tmp/rakazo", path.join(root, "runtime"));
        expect(command).toContain("Browser.close");
        waitForReady(joinedReady);
        const result = spawnSync("bash", ["-eu", "-c", command], {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            QUIESCE_LOG: log,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        const closed = readFileSync(log, "utf8").trim().split("\n");
        expect(closed).toEqual(
          expect.arrayContaining([
            String(bot.child.pid),
            String(primary.child.pid),
            String(joined.pid),
          ]),
        );
        expect(closed).not.toContain(String(botRenderer.child.pid));
        expect(closed).not.toContain(String(botHelper.child.pid));
        expect(spawnSync("kill", ["-0", String(botRenderer.child.pid)]).status).toBe(0);
        expect(spawnSync("kill", ["-0", String(botHelper.child.pid)]).status).toBe(0);
        expect(readFileSync(bot.cookies, "utf8")).toBe("session=kept");
        expect(readFileSync(primary.cookies, "utf8")).toBe("session=kept");
        expect(readFileSync(joinedCookies, "utf8")).toBe("session=kept");
      } finally {
        for (const child of children) {
          if (!child.pid) continue;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reads the debugging port from a space-joined Chromium command line",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "desktop-port-"));
      roots.push(root);
      const ready = path.join(root, "ready");
      const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
      }).stdout.trim();
      const joiner = path.join(root, "join-cmdline.py");
      writeFileSync(joiner, JOINED_COMMAND);
      const child = spawn(
        python,
        [
          joiner,
          "--user-data-dir=/tmp/my --type=renderer --remote-debugging-port=1 profile",
          "--remote-debugging-port=9444",
        ],
        { stdio: "ignore", detached: true, env: { ...process.env, JOINED_READY: ready } },
      );
      try {
        waitForReady(ready);
        const result = spawnSync(
          python,
          [
            "-c",
            browserCloseProgram(),
            String(child.pid),
            "/tmp/my --type=renderer --remote-debugging-port=1 profile",
            "--print-port",
          ],
          {
            encoding: "utf8",
            timeout: 5_000,
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe("9444");
      } finally {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    },
  );

  it("keeps provider authentication while adding the per-lease websocket capability", () => {
    const url = new URL(
      desktopUrl("https://desktop.test/vnc.html?_token=provider-key", "view-key"),
    );
    expect(url.searchParams.get("_token")).toBe("provider-key");
    expect(url.searchParams.get("path")).toBe("websockify?_token=provider-key&token=view-key");
  });
});
