import { Duplex, Readable, Writable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computerCommandEnv } from "./supervisor-logic.js";

type ExecOptions = { Cmd: string[]; Env?: string[]; User?: string };

const mock = vi.hoisted(() => ({
  exec: vi.fn(),
  inspect: vi.fn(),
  failWhen: (_options: { Cmd: string[] }): boolean => false,
}));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";

beforeEach(() => {
  mock.exec.mockReset();
  mock.inspect.mockReset();
  mock.failWhen = () => false;
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
    },
    State: { Running: true, StartedAt: "2026-01-01T00:00:00Z" },
    HostConfig: {},
  });
  mock.exec.mockImplementation(async (options: ExecOptions) => ({
    start: async () =>
      Duplex.from({
        readable: Readable.from([]),
        writable: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
      }),
    inspect: async () => ({ ExitCode: mock.failWhen(options) ? 1 : 0 }),
  }));
});

function post(path: string, body: unknown) {
  return supervisorApp.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify(body),
  });
}

const execs = () => mock.exec.mock.calls.map(([options]) => options as ExecOptions);

// Every exec, including file writes for uploads, inherits the container's non-root user
// (see containerCreateOptions) instead of naming one.
function expectContainerUser() {
  expect(execs().length).toBeGreaterThan(0);
  for (const options of execs()) expect(options).not.toHaveProperty("User");
}

describe("computer command identity", () => {
  it("runs the bot's commands with the workspace environment and the container's user", async () => {
    const response = await post("/computers/computer-exec/exec", {
      argv: ["echo", "hi"],
      env: { EXTRA: "1" },
    });
    await response.text();
    expect(execs().at(-1)?.Env).toEqual([...computerCommandEnv({ display: ":1" }), "EXTRA=1"]);
    expectContainerUser();
  });

  it("starts the user's terminal with the same environment and user as the bot's shell", async () => {
    mock.failWhen = (options) => options.Cmd.join(" ").includes("terminal-fixture-token");
    const response = await post("/computers/computer-terminal/terminal", {
      controlToken: "terminal-fixture-token",
    });
    expect(response.status).toBe(400);
    const terminal = execs().find((options) =>
      options.Cmd.join(" ").includes("terminal-fixture-token"),
    );
    expect(terminal?.Env).toEqual(computerCommandEnv({ display: ":1" }));
    expectContainerUser();
  });

  it("writes uploaded files as the container's user", async () => {
    const response = await post("/computers/computer-files/files", {
      path: "notes.txt",
      content: Buffer.from("hello").toString("base64"),
    });
    expect(response.status).toBe(200);
    expect(execs().at(-1)?.Cmd[0]).toBe("python3");
    expectContainerUser();
  });
});
