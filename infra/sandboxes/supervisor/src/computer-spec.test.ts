import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPUTER_IMAGE,
  containerCreateOptions,
  containerNameFor,
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
      workspaceId: "ws",
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
    expect(options.ExposedPorts).toEqual({
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
    expect(options.HostConfig.PortBindings["6080/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");
    expect(options.HostConfig.PortBindings["6081/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");
    expect(options.HostConfig.PortBindings["6082/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");
    expect(screenPorts(0)).toMatchObject({ display: ":1", viewPort: "6080", controlPort: "6081" });
    expect(screenPorts(1)).toMatchObject({ display: ":2", viewPort: "6082", controlPort: "6083" });
    expect(options.HostConfig.ShmSize).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(options.HostConfig.ReadonlyPaths).toContain("/usr/share/novnc");
    expect(options.HostConfig.NetworkMode).toBe("rakazo_default");
  });

  it("ships a browser desktop, not a fullscreen terminal", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    const start = readFileSync(path.join(root, "start.sh"), "utf8");
    const browser = readFileSync(path.join(root, "rakazo-browser"), "utf8");
    expect(dockerfile).toMatch(/chromium/);
    expect(start).toMatch(/rakazo-browser/);
    expect(start).toMatch(/x11vnc .* -viewonly /);
    expect(browser).toMatch(/\.browser-profiles\/chromium/);
    expect(start).not.toMatch(/windowsize 1280 800/);
  });

  it("keeps container names stable so a bot can resume", () => {
    expect(containerNameFor("bot_1")).toBe("rakazo-bot-bot_1");
    expect(containerNameFor("bot_1")).toBe(containerNameFor("bot_1"));
  });

  it("points the screen at the chrome-less noVNC embed", () => {
    expect(screenUrlFor("16080")).toBe("http://127.0.0.1:16080/embed.html");
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
