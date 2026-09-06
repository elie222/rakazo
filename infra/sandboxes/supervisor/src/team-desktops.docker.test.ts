import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { screenPorts } from "./computer-spec.js";
import {
  browserProfilePathForScreen,
  ensureScreenCommand,
  interactiveScreenCommand,
  resetManagedScreensCommand,
  stopExtraScreenCommand,
} from "./supervisor-logic.js";

// Build the computer image first. This opt-in check needs Docker but no network or credentials.
it.skipIf(process.env.VERIFY_DOCKER_TEAM_SCREENS !== "1")(
  "isolates live desktops, recovers profiles, and rejects recycled screen capabilities",
  () => {
    const name = `rakazo-team-screens-test-${randomUUID()}`;
    const directory = mkdtempSync(path.join(tmpdir(), "rakazo-team-screens-"));
    const docker = (...args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", timeout: 150_000 });
    try {
      const commands: Record<string, string> = { reset: resetManagedScreensCommand() };
      for (const [bot, index] of [
        ["a", 0],
        ["b", 1],
        ["c", 0],
      ] as const) {
        commands[`ensure${bot}`] = ensureScreenCommand(index, `bot-${bot}`, `view-${bot}`);
        commands[`stop${bot}`] = stopExtraScreenCommand(index, `bot-${bot}`);
        commands[`profile${bot}`] = browserProfilePathForScreen(`bot-${bot}`);
        commands[`control${bot}`] = interactiveScreenCommand(
          true,
          `control-${bot}`,
          screenPorts(index),
        );
      }
      const commandFile = path.join(directory, "commands.json");
      writeFileSync(commandFile, JSON.stringify(commands));
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "none",
        "--shm-size=512m",
        process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local",
      );
      docker("cp", commandFile, `${name}:/tmp/team-desktops-commands.json`);
      docker(
        "cp",
        fileURLToPath(new URL("../../computer/test_team_desktops.py", import.meta.url)),
        `${name}:/tmp/test_team_desktops.py`,
      );
      expect(
        docker(
          "exec",
          name,
          "python3",
          "/tmp/test_team_desktops.py",
          "/tmp/team-desktops-commands.json",
        ),
      ).toContain("PASS: parallel desktops");
    } finally {
      try {
        docker("rm", "-f", name);
      } catch {
        // Cleanup must not replace the original test failure.
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
  180_000,
);
