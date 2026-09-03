import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPUTER_IMAGE,
  computerNetworkNameFor,
  computerNetworkNamesForCleanup,
  containerCreateOptions,
  containerNameFor,
  hostComputerUser,
  legacyNetworkOwnedSolelyBy,
  resolveComputerControlEndpoint,
  resolveScreenNetworkMode,
  resolveScreenPublishTarget,
  screenPorts,
  screenUrlFor,
  xdotoolCommand,
} from "./computer-spec.js";

describe("graphical computer spec", () => {
  it("creates a VNC desktop, not an alpine sleep fallback", () => {
    const options = containerCreateOptions({
      name: "rakazo-bot-abc",
      image: COMPUTER_IMAGE,
      botId: "abc",
      spaceId: "ws",
      homePath: "/var/rakazo/homes/abc",
      networkMode: "rakazo_default",
    });
    expect(options.Image).toBe("rakazo/computer:local");
    expect(options.Image).not.toMatch(/alpine/);
    expect(options).not.toHaveProperty("Entrypoint");
    expect(JSON.stringify(options)).not.toMatch(/sleep/);
    expect(options.HostConfig.Binds).toEqual(["/var/rakazo/homes/abc:/home/rakazo"]);
    expect(options.Env).toContain(
      "PATH=/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(options.Env).toContain("NPM_CONFIG_PREFIX=/home/rakazo/.local");
    expect(options.ExposedPorts).toMatchObject({
      "6080/tcp": {},
      "6081/tcp": {},
      "6082/tcp": {},
      "6083/tcp": {},
      "6084/tcp": {},
      "6085/tcp": {},
      "6086/tcp": {},
      "6087/tcp": {},
      "6088/tcp": {},
      "6089/tcp": {},
      "6090/tcp": {},
      "6091/tcp": {},
      "6092/tcp": {},
      "6093/tcp": {},
      "6094/tcp": {},
      "6095/tcp": {},
    });
    expect(options.ExposedPorts).not.toHaveProperty("7070/tcp");
    expect(options.HostConfig.PortBindings).not.toHaveProperty("7070/tcp");
    expect(options.HostConfig.PortBindings["6080/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");
    expect(options.HostConfig.PortBindings["6081/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");
    expect(options.HostConfig.PortBindings["6082/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");
    expect(screenPorts(0)).toMatchObject({ display: ":1", viewPort: "6080", controlPort: "6081" });
    expect(screenPorts(1)).toMatchObject({ display: ":2", viewPort: "6082", controlPort: "6083" });
    expect(options.HostConfig.ShmSize).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(options.User).toBe("1000:1000");
    expect(options.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(options.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(options.HostConfig.PidsLimit).toBe(2048);
    expect(options.HostConfig.ReadonlyPaths).toContain("/usr/share/novnc");
    expect(options.HostConfig.NetworkMode).toBe("rakazo_default");
  });

  it("still publishes host ports when NetworkMode is a per-bot isolated network", () => {
    const networkMode = computerNetworkNameFor("bot_isolation");
    const options = containerCreateOptions({
      name: containerNameFor("bot_isolation"),
      image: COMPUTER_IMAGE,
      botId: "bot_isolation",
      spaceId: "ws",
      homePath: "/var/rakazo/homes/bot_isolation",
      networkMode,
    });
    expect(networkMode).toMatch(/^rakazo-computer-bot_isolation-[0-9a-f]{32}$/);
    expect(options.HostConfig.NetworkMode).toBe(networkMode);
    expect(options.HostConfig.PortBindings["6080/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "0" },
    ]);
    expect(options.ExposedPorts["6080/tcp"]).toEqual({});
  });

  it("keeps sanitized network names unique when botIds only differ by stripped characters", () => {
    expect(computerNetworkNameFor("a/b")).not.toBe(computerNetworkNameFor("ab"));
    expect(computerNetworkNameFor("a/b")).toBe(computerNetworkNameFor("a/b"));
  });

  it("lists prior network name variants for cleanup", () => {
    const names = computerNetworkNamesForCleanup("bot_1");
    expect(names[0]).toBe(computerNetworkNameFor("bot_1"));
    expect(names).toContain("rakazo-computer-bot_1");
    expect(names.some((name) => /-[0-9a-f]{8}$/.test(name))).toBe(true);
    expect(names.some((name) => /-[0-9a-f]{32}$/.test(name))).toBe(true);
  });

  it("skips legacy network removal when another bot is still attached", () => {
    expect(legacyNetworkOwnedSolelyBy("a/b", ["a/b", "a/b"])).toBe(true);
    expect(legacyNetworkOwnedSolelyBy("a/b", ["a/b", undefined])).toBe(false);
    expect(legacyNetworkOwnedSolelyBy("a/b", ["a/b", "ab"])).toBe(false);
    expect(legacyNetworkOwnedSolelyBy("ab", [undefined, undefined])).toBe(false);
  });

  it("ships a browser desktop with one-click app launchers", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    const start = readFileSync(path.join(root, "start.sh"), "utf8");
    const browser = readFileSync(path.join(root, "rakazo-browser"), "utf8");
    const desktop = readFileSync(path.join(root, "rakazo-browser.desktop"), "utf8");
    const terminalDesktop = readFileSync(path.join(root, "rakazo-terminal.desktop"), "utf8");
    const filesDesktop = readFileSync(path.join(root, "rakazo-files.desktop"), "utf8");
    const panelLauncher = readFileSync(path.join(root, "rakazo-desktop-panel"), "utf8");
    const fluxbox = readFileSync(path.join(root, "fluxbox.init"), "utf8");
    const panel = readFileSync(path.join(root, "tint2rc"), "utf8");
    const menu = readFileSync(path.join(root, "fluxbox.menu"), "utf8");
    expect(dockerfile).toMatch(/chromium/);
    expect(dockerfile).toMatch(/pcmanfm/);
    expect(dockerfile).toMatch(/tint2/);
    expect(dockerfile).toMatch(/rakazo-browser\.desktop/);
    expect(dockerfile).toMatch(/rakazo-terminal\.desktop/);
    expect(dockerfile).toMatch(/rakazo-files\.desktop/);
    expect(dockerfile).toMatch(/tint2rc/);
    expect(dockerfile).toMatch(/control.py/);
    expect(dockerfile).toMatch(/USER 1000:1000/);
    expect(start).toMatch(/rakazo-computer-control/);
    expect(start).toMatch(/rakazo-browser/);
    expect(dockerfile).toMatch(/rakazo-desktop-panel/);
    expect(start).toMatch(/SingletonLock/);
    expect(start).toMatch(/xdg-mime default rakazo-browser\.desktop/);
    expect(start).toMatch(/register_browser_handler x-scheme-handler\/http/);
    expect(start).toMatch(/register_browser_handler x-scheme-handler\/https/);
    expect(start).toMatch(/register_browser_handler text\/html/);
    expect(start).toMatch(/xdg-mime query default/);
    expect(start).toMatch(/failed to register rakazo-browser/);
    expect(start).toMatch(/failed to set default web browser/);
    expect(start).toMatch(/-z "\$\{BROWSER:-\}"/);
    expect(start).toMatch(/xdg-settings set default-web-browser rakazo-browser\.desktop/);
    expect(start).not.toMatch(/xdg-mime default rakazo-browser\.desktop .*\|\| true/);
    expect(start).toMatch(/x11vnc .* -viewonly /);
    expect(browser).toMatch(/\.browser-profiles\/chromium/);
    expect(browser).toMatch(/chromium-screen-\$\{DISPLAY/);
    expect(browser).toMatch(/USER_DATA_DIR_SET/);
    expect(desktop).toMatch(/Exec=\/usr\/local\/bin\/rakazo-browser %U/);
    expect(desktop).toMatch(/Icon=\/usr\/share\/icons\/hicolor\/128x128\/apps\/chromium\.png/);
    expect(desktop).toMatch(/x-scheme-handler\/http/);
    expect(desktop).toMatch(/x-scheme-handler\/https/);
    expect(terminalDesktop).toMatch(/Exec=xterm .*rgb:11\/11\/13/);
    expect(filesDesktop).toMatch(/Exec=pcmanfm/);
    expect(panelLauncher).toMatch(/tint2 -c \/etc\/rakazo\/tint2rc/);
    expect(start).toMatch(/rakazo-desktop-panel/);
    expect(fluxbox).not.toMatch(/rootCommand/);
    expect(panel).toMatch(/panel_items = LT/);
    expect(panel).toMatch(/rakazo-browser\.desktop/);
    expect(panel).toMatch(/rakazo-files\.desktop/);
    expect(panel).toMatch(/rakazo-terminal\.desktop/);
    expect(menu).not.toMatch(/xterm -bg #/);
    expect(start).not.toMatch(/windowsize 1280 800/);
  });

  it.skipIf(process.platform === "win32")(
    "selects a display-specific browser profile and preserves explicit profiles",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-browser-wrapper-"));
      const bin = path.join(temp, "bin");
      const capture = path.join(temp, "args");
      const home = path.join(temp, "home");
      const chromium = path.join(bin, "chromium");
      mkdirSync(bin);
      writeFileSync(chromium, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RAKAZO_TEST_ARGS"\n');
      chmodSync(chromium, 0o755);

      const run = (display: string, args: string[] = []) => {
        const result = spawnSync("bash", [path.join(root, "rakazo-browser"), ...args], {
          env: {
            ...process.env,
            DISPLAY: display,
            HOME: home,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            RAKAZO_TEST_ARGS: capture,
          },
          encoding: "utf8",
        });
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);
        return readFileSync(capture, "utf8").trim().split(/\r?\n/);
      };

      try {
        expect(run(":1")).toContain(`--user-data-dir=${home}/.browser-profiles/chromium`);
        expect(run(":2")).toContain(`--user-data-dir=${home}/.browser-profiles/chromium-screen-2`);
        const explicit = run(":3", [`--user-data-dir=${home}/custom-profile`]);
        expect(explicit).toContain(`--user-data-dir=${home}/custom-profile`);
        expect(explicit).not.toContain(
          `--user-data-dir=${home}/.browser-profiles/chromium-screen-3`,
        );
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "clears crashed state from Chromium preferences and Local State",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-browser-crash-"));
      const bin = path.join(temp, "bin");
      const home = path.join(temp, "home");
      const chromium = path.join(bin, "chromium");
      const capture = path.join(temp, "args");
      mkdirSync(bin);
      writeFileSync(chromium, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RAKAZO_TEST_ARGS"\n');
      chmodSync(chromium, 0o755);

      const profile = path.join(home, ".browser-profiles/chromium");
      const prefsDir = path.join(profile, "Default");
      mkdirSync(prefsDir, { recursive: true });
      const prefsPath = path.join(prefsDir, "Preferences");
      const localStatePath = path.join(profile, "Local State");
      writeFileSync(
        prefsPath,
        '{\n  "profile": {\n    "exit_type": "Crashed",\n    "exited_cleanly": false\n  }\n}\n',
      );
      writeFileSync(localStatePath, '{\n  "profile": {\n    "exited_cleanly": false\n  }\n}\n');

      try {
        const result = spawnSync("bash", [path.join(root, "rakazo-browser")], {
          env: {
            ...process.env,
            DISPLAY: ":1",
            HOME: home,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            RAKAZO_TEST_ARGS: capture,
          },
          encoding: "utf8",
        });
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);

        const flags = readFileSync(capture, "utf8");
        expect(flags).toMatch(/--hide-crash-restore-bubble/);
        expect(flags).toMatch(/--disable-session-crashed-bubble/);

        const updatedPrefs = readFileSync(prefsPath, "utf8");
        expect(updatedPrefs).toContain('"exit_type":"Normal"');
        expect(updatedPrefs).toContain('"exited_cleanly":true');
        expect(updatedPrefs).not.toContain("Crashed");
        expect(updatedPrefs).not.toMatch(/"exited_cleanly"\s*:\s*false/);

        const updatedLocalState = readFileSync(localStatePath, "utf8");
        expect(updatedLocalState).toContain('"exited_cleanly":true');
        expect(updatedLocalState).not.toMatch(/"exited_cleanly"\s*:\s*false/);

        writeFileSync(prefsPath, '{\n  "profile": {\n    "exit_type": "Crashed"\n  }\n}\n');
        symlinkSync("testhost-12345", path.join(profile, "SingletonLock"));
        const skipped = spawnSync("bash", [path.join(root, "rakazo-browser")], {
          env: {
            ...process.env,
            DISPLAY: ":1",
            HOME: home,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            RAKAZO_TEST_ARGS: capture,
          },
          encoding: "utf8",
        });
        expect(skipped.status, skipped.error?.message ?? skipped.stderr).toBe(0);
        expect(readFileSync(prefsPath, "utf8")).toContain("Crashed");
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("keeps container names stable so a bot can resume", () => {
    expect(containerNameFor("bot_1")).toBe("rakazo-bot-bot_1");
    expect(containerNameFor("bot_1")).toBe(containerNameFor("bot_1"));
  });

  it("points the screen at the chrome-less noVNC embed", () => {
    expect(screenUrlFor("16080")).toBe("http://127.0.0.1:16080/embed.html");
  });

  it("wires host clipboard paste into the chrome-less embed", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const embed = readFileSync(path.join(root, "embed.html"), "utf8");
    expect(embed).toMatch(/clipboard-bridge\.js/);
    expect(embed).toMatch(/attachHostClipboardPaste/);
  });

  it("uses the published host mapping in the default topology even when a container IP exists", () => {
    // Regression: per-bot NetworkMode always yields a 172.x address. Returning
    // that to clients makes local/dev screens look dead — browsers cannot load
    // docker-internal IPs. Probe and return the host mapping instead.
    const networkMode = computerNetworkNameFor("bot_1");
    expect(
      resolveScreenPublishTarget({
        screenNetwork: "published",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        hostPort: "49152",
        containerPort: "6080",
      }),
    ).toEqual({ host: "127.0.0.1", port: "49152" });
    expect(
      resolveScreenPublishTarget({
        screenNetwork: "published",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        hostPort: undefined,
        containerPort: "6080",
      }),
    ).toBeUndefined();
  });

  it("validates the configured screen network mode", () => {
    expect(resolveScreenNetworkMode(undefined)).toBe("published");
    expect(resolveScreenNetworkMode("published")).toBe("published");
    expect(resolveScreenNetworkMode("isolated")).toBe("isolated");
    expect(() => resolveScreenNetworkMode("typo")).toThrow(/Unsupported/);
  });

  it("uses the host identity for host-run bind mounts without ever using root", () => {
    expect(hostComputerUser(501, 20)).toBe("501:20");
    expect(hostComputerUser(0, 0)).toBe("1000:1000");
  });

  it("uses the container IP only for the internal screen network topology", () => {
    const networkMode = "rakazo_default";
    expect(
      resolveScreenPublishTarget({
        screenNetwork: "internal",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        hostPort: "49152",
        containerPort: "6080",
      }),
    ).toEqual({ host: "172.18.0.4", port: "6080" });
    expect(
      resolveScreenPublishTarget({
        screenNetwork: "isolated",
        networkMode: "rakazo-computer-bot-1",
        networks: { "rakazo-computer-bot-1": { IPAddress: "172.20.0.4" } },
        hostPort: "49152",
        containerPort: "6080",
      }),
    ).toEqual({ host: "172.20.0.4", port: "6080" });
  });

  it("does not publish computer control port 7070 on the host", () => {
    const options = containerCreateOptions({
      name: "rakazo-bot-ctrl",
      image: COMPUTER_IMAGE,
      botId: "ctrl",
      spaceId: "ws",
      homePath: "/var/rakazo/homes/ctrl",
    });
    expect(options.HostConfig.PortBindings["7070/tcp"]).toBeUndefined();
    expect(options.ExposedPorts["7070/tcp"]).toBeUndefined();
    expect(JSON.stringify(options.HostConfig.PortBindings)).not.toMatch(/7070/);
  });

  it("resolves computer control through the container network IP, never a host mapping", () => {
    const networkMode = "rakazo_default";
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
      }),
    ).toEqual({ url: "http://172.18.0.4:7070/v1/desktop", token: "secret" });
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode: computerNetworkNameFor("bot_1"),
        networks: { [computerNetworkNameFor("bot_1")]: { IPAddress: "172.19.0.2" } },
      }),
    ).toEqual({ url: "http://172.19.0.2:7070/v1/desktop", token: "secret" });
    expect(
      resolveComputerControlEndpoint({
        token: undefined,
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
      }),
    ).toBeUndefined();
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode,
        networks: {},
      }),
    ).toBeUndefined();
  });

  it("restricts computer control argv to supervisor shapes", () => {
    const controlPath = path.resolve(import.meta.dirname, "../../computer/control.py");
    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import importlib.util",
          "import os",
          "import signal",
          "import time",
          `spec = importlib.util.spec_from_file_location('control', ${JSON.stringify(controlPath)})`,
          "module = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "allow = module.allowed_control_argv",
          "long_lived = module.is_long_lived_control",
          "assert allow(['env', 'DISPLAY=:1', 'xdotool', 'key', '--clearmodifiers', 'a'], ':1')",
          "assert allow(['env', 'DISPLAY=:1', 'xdotool', 'mousemove', '--', '10', '20', 'click', '1'], ':1')",
          "assert allow(['env', 'DISPLAY=:1', 'xdotool', 'click', '--repeat', '3', '4'], ':1')",
          "assert allow(['env', 'DISPLAY=:1', 'xdotool', 'type', '--clearmodifiers', '--', 'hi'], ':1')",
          "assert allow(['env', 'DISPLAY=:2', 'xdg-open', 'https://example.com'], ':2')",
          "assert allow(['env', 'DISPLAY=:1', 'rakazo-browser'], ':1')",
          "assert allow(['env', 'DISPLAY=:2', 'rakazo-browser', 'https://example.com'], ':2')",
          "assert allow(['env', 'DISPLAY=:1', 'xterm'], ':1')",
          "assert allow(['env', 'DISPLAY=:1', 'pcmanfm'], ':1')",
          "assert long_lived(['env', 'DISPLAY=:1', 'rakazo-browser'])",
          "assert long_lived(['env', 'DISPLAY=:1', 'rakazo-browser', 'https://example.com'])",
          "assert long_lived(['env', 'DISPLAY=:1', 'xterm'])",
          "assert long_lived(['env', 'DISPLAY=:1', 'pcmanfm'])",
          "assert long_lived(['env', 'DISPLAY=:1', 'xdg-open', 'https://example.com'])",
          "assert not long_lived(['env', 'DISPLAY=:1', 'xdotool', 'key', '--clearmodifiers', 'a'])",
          "assert not allow(['env', 'DISPLAY=:1', 'chromium', 'https://example.com'], ':1')",
          "assert not allow(['bash', '-c', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'bash', '-c', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', '/bin/sh', '-c', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'xdotool', 'exec', '/bin/sh', '-c', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'xdotool', 'key', 'a'], ':1')",
          "assert not allow(['env', 'DISPLAY=:2', 'xdotool', 'key', '--clearmodifiers', 'a'], ':1')",
          "assert not allow(['env', 'DISPLAY=wayland-0', 'xdotool', 'key', '--clearmodifiers', 'a'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'xdg-open', 'a', 'b'], ':1')",
          "known = set(module.KNOWN_LAUNCH)",
          "module.KNOWN_LAUNCH = frozenset({'sleep'})",
          "spawned = []",
          "real_popen = module.subprocess.Popen",
          "def tracking_popen(*args, **kwargs):",
          "  child = real_popen(*args, **kwargs)",
          "  spawned.append(child.pid)",
          "  return child",
          "module.subprocess.Popen = tracking_popen",
          "try:",
          "  started = time.monotonic()",
          "  module.run_control_argv(['env', 'DISPLAY=:1', 'sleep', '30'], ':1')",
          "  assert time.monotonic() - started < 2",
          "  assert len(spawned) == 1, 'expected one detached child'",
          "  os.kill(spawned[0], 0)",
          "  os.kill(spawned[0], signal.SIGTERM)",
          "finally:",
          "  module.subprocess.Popen = real_popen",
          "  module.KNOWN_LAUNCH = frozenset(known)",
          "try:",
          "  module.run_control_argv(['env', 'DISPLAY=:1', 'false'], ':1')",
          "  raise SystemExit('expected nonzero failure')",
          "except RuntimeError as error:",
          "  assert str(error) == 'computer action failed'",
          "timeout = module.CONTROL_TIMEOUT_SEC",
          "module.CONTROL_TIMEOUT_SEC = 0.2",
          "try:",
          "  module.run_control_argv(['env', 'DISPLAY=:1', 'sleep', '5'], ':1')",
          "  raise SystemExit('expected timeout')",
          "except RuntimeError as error:",
          "  assert str(error) == 'computer action timed out'",
          "finally:",
          "  module.CONTROL_TIMEOUT_SEC = timeout",
          "print('ok')",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("turns takeover input into xdotool", () => {
    expect(xdotoolCommand({ kind: "key", key: "Enter" })).toEqual([
      "xdotool",
      "key",
      "--clearmodifiers",
      "Return",
    ]);
    expect(xdotoolCommand({ kind: "pointer", x: 10, y: 20, type: "click" })).toEqual([
      "xdotool",
      "mousemove",
      "--",
      "10",
      "20",
      "click",
      "1",
    ]);
  });
});
