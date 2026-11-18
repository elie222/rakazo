import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeTailnetCommand } from "./computers/host/native-shell.js";

const hasPwsh =
  spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    stdio: "ignore",
  }).status === 0;

describe("native tailnet install on Windows", () => {
  const command = nativeTailnetCommand("Write-Output ready", "win32");

  it("reads a helper file and does not call the py launcher", () => {
    expect(command).not.toContain("RAKAZO_NET_HELPER");
    expect(command).not.toContain("py -3");
    expect(command).not.toContain("py.exe");
    expect(command).toContain("RAKAZO_NET_FILE");
    expect(command).toContain("-Encoding ascii");
    expect(command).toContain("python");
  });

  it.runIf(hasPwsh)("writes the cmd launcher from the helper file", async () => {
    const home = await mkdtemp(join(tmpdir(), "rkz-net-"));
    const source = join(home, "helper.py");
    await writeFile(source, "print('rakazo-net')\n");
    try {
      const output = execFileSync(
        "pwsh",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        {
          env: {
            ...process.env,
            RAKAZO_NET_FILE: source,
            RAKAZO_NET_VERSION: "abc",
            RAKAZO_NET_HOME: home,
          },
          encoding: "utf8",
        },
      );
      expect(output.trim()).toBe("ready");
      const cmd = await readFile(
        join(home, ".cache", "rakazo", "net", "abc", "rakazo-net.cmd"),
        "utf8",
      );
      expect(cmd).not.toContain("py -3");
      expect(cmd).not.toContain("py.exe");
      expect(cmd).toContain("python");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
