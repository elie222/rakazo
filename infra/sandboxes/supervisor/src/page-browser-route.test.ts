import { PassThrough, Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ exec: vi.fn(), inspect: vi.fn() }));
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
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
    },
  });
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => ({
    start: async () =>
      Readable.from([
        Buffer.from(
          options.Cmd.includes("/usr/local/bin/rakazo-page-browser")
            ? JSON.stringify({
                ok: true,
                url: "https://example.test",
                title: "Fixture",
                tree: "",
                elements: [],
              })
            : "",
        ),
      ]),
    inspect: async () => ({ ExitCode: 0 }),
  }));
});

async function snapshot(id: string, screen: string, lease: string, home = "home") {
  return supervisorApp.request(`/computers/${id}/browser`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": home,
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": screen,
      "x-rakazo-screen-lease-id": lease,
    },
    body: JSON.stringify({ command: "snapshot" }),
  });
}

it("resolves the owned display and refuses an older fence before running the helper", async () => {
  expect(await (await snapshot("computer-lease", "first", "run:2")).json()).toMatchObject({
    ok: true,
  });
  expect(await (await snapshot("computer-lease", "second", "other:2")).json()).toMatchObject({
    ok: true,
  });
  expect(mock.exec.mock.calls.at(-1)?.[0]).toMatchObject({
    Env: [
      "DISPLAY=:2",
      "RAKAZO_CDP_PORT=9223",
      "HOME=/home/rakazo",
      "RAKAZO_BROWSER_WATCH_STDIN=1",
    ],
  });
  mock.exec.mockClear();
  expect(await (await snapshot("computer-lease", "first", "run:1")).json()).toMatchObject({
    ok: false,
  });
  expect(mock.exec).not.toHaveBeenCalled();
});

it("rejects another computer identity before any command executes", async () => {
  expect(
    await (await snapshot("computer-identity", "first", "run:1", "foreign-home")).json(),
  ).toMatchObject({ ok: false });
  expect(mock.exec).not.toHaveBeenCalled();
});

it.each(["http", "https"])(
  "rejects %s URL credentials before executing any command",
  async (scheme) => {
    const response = await supervisorApp.request("/computers/computer-credentials/browser", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "navigate",
        url: `${scheme}://example:fake-password@example.test`,
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mock.exec).not.toHaveBeenCalled();
    expect(mock.inspect).not.toHaveBeenCalled();
  },
);

it("closes helper stdin when the request is cancelled", async () => {
  const stream = new PassThrough();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const defaultExec = mock.exec.getMockImplementation()!;
  mock.exec.mockImplementation(async (options: { Cmd: string[]; AttachStdin?: boolean }) => {
    if (!options.Cmd.includes("/usr/local/bin/rakazo-page-browser")) return defaultExec(options);
    expect(options.AttachStdin).toBe(true);
    return {
      start: async (options: { stdin: boolean }) => {
        expect(options.stdin).toBe(true);
        started();
        return stream;
      },
      inspect: async () => ({ ExitCode: 130 }),
    };
  });
  const response = supervisorApp.request("/computers/computer-cancel/browser", {
    method: "POST",
    signal: controller.signal,
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify({ command: "act", actions: [{ kind: "click", ref: "test-ref" }] }),
  });
  await ready;
  controller.abort();
  expect(await (await response).json()).toMatchObject({ ok: false, uncertain: true });
  expect(stream.destroyed).toBe(true);
});
