import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeTerminalInput, encodeTerminalResize } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { screenPorts, startTerminalCommand } from "./desktop-runtime.js";
import { TERMINAL_SERVER_PROGRAM } from "./terminal-server.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

async function startServer(asUser?: { uid: number; gid: number }) {
  const root = mkdtempSync(path.join(tmpdir(), "terminal-server-"));
  const program = path.join(root, "server.py");
  const socket = path.join(root, "pty.sock");
  const state = path.join(root, "state");
  writeFileSync(program, TERMINAL_SERVER_PROGRAM);
  const argv = [program, socket, root, state];
  if (asUser) chmodSync(root, 0o777);
  const server: ChildProcess = asUser
    ? spawn(
        "setpriv",
        [`--reuid=${asUser.uid}`, `--regid=${asUser.gid}`, "--clear-groups", "python3", ...argv],
        { env: { PATH: process.env.PATH, HOME: root, SHELL: "/bin/bash" }, stdio: "ignore" },
      )
    : spawn("python3", argv, {
        env: { PATH: process.env.PATH, HOME: root, SHELL: "/bin/sh" },
        stdio: "ignore",
      });
  cleanup.push(() => {
    server.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !existsSync(socket); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { root, socket, state, server };
}

function connect(socket: string) {
  const client = net.createConnection(socket);
  cleanup.push(() => client.destroy());
  let output = "";
  client.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const waitFor = async (pattern: RegExp) => {
    for (let i = 0; i < 250; i += 1) {
      if (pattern.test(output)) return output;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`terminal output did not match ${pattern}: ${output}`);
  };
  return { client, waitFor };
}

describe("terminal server", () => {
  it("runs a shell in the workspace and applies resize frames", async () => {
    const { root, socket } = await startServer();
    const { client, waitFor } = connect(socket);
    client.write(encodeTerminalResize(123, 45));
    // Split one frame across writes: framing must survive arbitrary stream chunking.
    const frame = encodeTerminalInput("pwd; stty size; echo done-$((20 + 22))\n");
    client.write(frame.subarray(0, 3));
    client.write(frame.subarray(3));
    const output = await waitFor(/done-42/);
    expect(output).toContain(root);
    expect(output).toContain("45 123");
  });

  it("gives each connection its own shell", async () => {
    const { socket } = await startServer();
    const first = connect(socket);
    const second = connect(socket);
    first.client.write(encodeTerminalInput("export MARK=first; echo set-$MARK\n"));
    await first.waitFor(/set-first/);
    second.client.write(encodeTerminalInput("echo other-$MARK-end\n"));
    await expect(second.waitFor(/other--end/)).resolves.toContain("other--end");
  });

  // Docker on macOS runs computers as the host uid, which has no passwd entry in the image.
  const canSwitchUser =
    process.getuid?.() === 0 &&
    spawnSync("sh", ["-c", "command -v setpriv && ls /usr/lib/*/libnss_wrapper.so"]).status === 0 &&
    spawnSync("getent", ["passwd", "501"]).status !== 0;
  it.skipIf(!canSwitchUser)("names a uid that has no passwd entry", async () => {
    const { socket, state } = await startServer({ uid: 501, gid: 20 });
    const { client, waitFor } = connect(socket);
    client.write(encodeTerminalInput("echo who-$(whoami)-$USER\n"));
    await expect(waitFor(/who-rakazo-rakazo/)).resolves.toContain("who-rakazo-rakazo");
    expect(readdirSync(state)).toHaveLength(2);
    // Stopping the terminal signals every session; each removes its identity files.
    spawnSync("pkill", ["-TERM", "-f", socket]);
    for (let i = 0; i < 100 && readdirSync(state).length > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readdirSync(state)).toEqual([]);
  });
});

// Runs the real start script against /tmp/rakazo on a display no computer uses.
const canRunScript =
  process.platform === "linux" && spawnSync("sh", ["-c", "command -v pgrep"]).status === 0;
describe.skipIf(!canRunScript)("terminal start script", () => {
  const layout = screenPorts(4000);
  const display = layout.displayNumber;
  const target = `/tmp/rakazo/desktop-targets/terminal-${display}`;
  const stop = () => {
    spawnSync("pkill", ["-KILL", "-f", `/tmp/rakazo/sockets/terminal-${display}-`]);
    rmSync(`/tmp/rakazo/control-token-${display}`, { force: true });
    rmSync(target, { force: true });
    rmSync(`/tmp/rakazo/terminal-state-${display}`, { recursive: true, force: true });
  };
  afterEach(stop);

  const start = (lease: string, token: string, cwd: string) => {
    writeFileSync(`/tmp/rakazo/control-token-${display}`, lease);
    return spawnSync(
      "bash",
      ["-eu", "-c", startTerminalCommand(lease, token, cwd, undefined, layout)],
      {
        encoding: "utf8",
      },
    );
  };
  const entries = () =>
    readFileSync(target, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(": unix_socket:"));

  it("keeps open shells when another tab joins, and replaces the server for a new lease", async () => {
    stop();
    mkdirSync("/tmp/rakazo", { recursive: true });
    const cwd = mkdtempSync(path.join(tmpdir(), "terminal-cwd-"));
    cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));

    expect(start("lease-a", "tab-1", cwd).status).toBe(0);
    const socket = entries()[0]![1]!;
    const first = connect(socket);
    first.client.write(encodeTerminalInput("echo first-$((40 + 2))\n"));
    await first.waitFor(/first-42/);

    expect(start("lease-a", "tab-2", cwd).status).toBe(0);
    expect(entries()).toEqual([
      ["tab-1", socket],
      ["tab-2", socket],
    ]);
    first.client.write(encodeTerminalInput("echo still-$((40 + 3))\n"));
    await expect(first.waitFor(/still-43/)).resolves.toContain("still-43");

    expect(start("lease-b", "tab-3", cwd).status).toBe(0);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]![0]).toBe("tab-3");
    expect(entries()[0]![1]).not.toBe(socket);
    expect(existsSync(socket)).toBe(false);

    expect(start("lease-c", "tab-4", cwd).status).toBe(0);
    writeFileSync(`/tmp/rakazo/control-token-${display}`, "lease-d");
    const stale = spawnSync(
      "bash",
      ["-eu", "-c", startTerminalCommand("lease-c", "tab-5", cwd, undefined, layout)],
      { encoding: "utf8" },
    );
    expect(stale.status).toBe(75);
  });
});
