import { describe, expect, it } from "vitest";
import { ComputerScreenUnavailableError } from "./computer-screens.js";
import {
  allocateExtraDisplayCommand,
  ensureExtraDisplayCommand,
  extraDisplayControlStartCommand,
  extraDisplayLayout,
  noVncProxyProcessPattern,
  parseAllocatedExtraDisplay,
  parseExtraDisplayViewPassword,
  parseReleasedExtraDisplay,
  releaseExtraDisplayCommand,
  websockifyProcessPattern,
} from "./extra-displays.js";

describe("extra display ports", () => {
  it("targets noVNC proxy processes without matching E2B's enclosing bash runner", () => {
    const layout = extraDisplayLayout(1, ":0");
    const commands = [
      ensureExtraDisplayCommand(
        layout,
        { homeDir: "/home/user", browserProfilesDir: "/home/user/.browser-profiles" },
        "test-password",
      ),
      extraDisplayControlStartCommand(layout, "test-control", "test-password"),
      releaseExtraDisplayCommand("test-bot", "test-lease:1"),
    ];
    for (const port of [layout.viewPort, layout.controlPort]) {
      const pattern = new RegExp(noVncProxyProcessPattern(port));
      for (const executable of [
        "./novnc_proxy",
        "/opt/noVNC/utils/novnc_proxy",
        "bash ./novnc_proxy",
        "/bin/bash /opt/noVNC/utils/novnc_proxy",
        "/usr/bin/bash ./novnc_proxy",
      ]) {
        expect(`${executable} --vnc localhost:5900 --listen ${port} --web /opt/noVNC`).toMatch(
          pattern,
        );
      }
      for (const command of commands) {
        expect(`/bin/bash -l -c ${command}`).not.toMatch(pattern);
      }
      expect(`bash ./novnc_proxy --vnc localhost:5900 --listen ${port}0`).not.toMatch(pattern);
      expect(`bash ./novnc_proxy --vnc localhost:5900 --listen ${port + 1}`).not.toMatch(pattern);
    }
  });

  it("targets module and executable websockify children on only the intended port", () => {
    const pattern = new RegExp(websockifyProcessPattern(6080));
    for (const command of [
      "python3 -m websockify --web /opt/noVNC 6080 localhost:5900",
      "/usr/bin/python3 -m websockify --web /opt/noVNC 6080 localhost:5900",
      "/usr/bin/python3 /opt/noVNC/utils/websockify/run --web /opt/noVNC 6080 localhost:5900",
      "/usr/bin/python3 /usr/bin/websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900",
    ]) {
      expect(command).toMatch(pattern);
      expect(`/bin/bash -l -c ${command}`).not.toMatch(pattern);
      expect(command.replace(/6080/g, "6081")).not.toMatch(pattern);
      expect(command.replace(/6080/g, "60800")).not.toMatch(pattern);
    }
  });

  it("keeps the vendor primary on index 0 and shifts extra screens by two", () => {
    expect(extraDisplayLayout(0, ":0")).toMatchObject({
      display: ":0",
      viewPort: 6080,
      controlPort: 6081,
      isPrimary: true,
    });
    expect(extraDisplayLayout(1, ":0")).toMatchObject({
      display: ":2",
      viewPort: 6082,
      controlPort: 6083,
      isPrimary: false,
    });
    expect(extraDisplayLayout(1, ":99")).toMatchObject({
      display: ":2",
      viewPort: 6082,
      controlPort: 6083,
    });
  });

  it("uses a locked sandbox registry for cross-process screen assignment", () => {
    const allocate = allocateExtraDisplayCommand("writer", "run-2:2");
    const release = releaseExtraDisplayCommand("writer", "run-2:2");
    expect(allocate).toContain("flock 9");
    expect(allocate).not.toContain("writer");
    expect(release).toContain("RAKAZO_SCREEN_RELEASE=stale");
    expect(release.indexOf("pkill -f")).toBeLessThan(release.indexOf('rm -f "$slot"'));
    expect(parseAllocatedExtraDisplay("RAKAZO_SCREEN_INDEX=3\n")).toBe(3);
    expect(parseReleasedExtraDisplay("RAKAZO_SCREEN_RELEASE=3\n")).toBe(3);
    expect(parseReleasedExtraDisplay("RAKAZO_SCREEN_RELEASE=stale\n")).toBeUndefined();
  });

  it("requires an authenticated password for view-only VNC", () => {
    expect(parseExtraDisplayViewPassword("RAKAZO_SCREEN_PASSWORD=sandbox_secret-1\n")).toBe(
      "sandbox_secret-1",
    );
    expect(() => parseExtraDisplayViewPassword("no password\n")).toThrow(
      ComputerScreenUnavailableError,
    );
  });
});
