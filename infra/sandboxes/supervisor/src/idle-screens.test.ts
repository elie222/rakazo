import type * as NodeHttp from "node:http";
import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core/node/secrets-guard";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computerNetworkNameFor } from "./computer-spec.js";
import { releaseAssignedScreen, SCREEN_IDLE_MS } from "./supervisor-logic.js";

const mocks = vi.hoisted(() => ({ getContainer: vi.fn() }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer = mocks.getContainer;
  },
}));
vi.mock("node:http", async (original) => {
  const http = await original<typeof NodeHttp>();
  return {
    ...http,
    default: {
      ...http,
      get: vi.fn((_options, callback) => {
        callback({ statusCode: 200, resume() {} });
        return {
          once() {
            return this;
          },
          destroy() {},
        };
      }),
    },
  };
});

const token = resolveSupervisorToken(process.env);
const preview = { interactive: false, revokeControl: false };

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("HOSTNAME", "");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "published");
  vi.stubEnv("SANDBOX_SCREEN_HOST", "127.0.0.1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** The command that stops a bot's viewer and browser, as eviction and the idle timeout run it. */
const isScreenClose = (command: string) =>
  /sockets\/view-\d+-/.test(command) && command.includes("Browser.close");

function fixture() {
  const commands: string[] = [];
  const computer = {
    running: true,
    startedAt: "boot-1",
    failCloses: false,
    failInspect: false,
    gate: undefined as Deferred<void> | undefined,
  };
  const container = {
    inspect: vi.fn(async () => {
      if (computer.failInspect)
        throw Object.assign(new Error("daemon unavailable"), { statusCode: 500 });
      return {
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        HostConfig: { NetworkMode: computerNetworkNameFor("bot") },
        State: { Running: computer.running, StartedAt: computer.startedAt },
        NetworkSettings: { Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "6080" }] } },
      };
    }),
    exec: vi.fn(async ({ Cmd }: { Cmd: string[] }) => {
      const command = Cmd.join(" ");
      commands.push(command);
      const gate = computer.gate;
      if (gate) {
        computer.gate = undefined;
        await gate.promise;
      }
      return {
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: computer.failCloses && isScreenClose(command) ? 1 : 0 }),
      };
    }),
  };
  mocks.getContainer.mockReturnValue(container);
  return { computer, container, closes: () => commands.filter(isScreenClose) };
}

async function supervisor() {
  const { supervisorApp } = await import("./index.js");
  const { getLogger } = await import("@rakazo/logging");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const logError = vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
  const screenMode = (body: object, options: { leaseId?: string; screenId?: string } = {}) =>
    supervisorApp.request("/computers/computer/screen-mode", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
        "x-rakazo-screen-id": options.screenId ?? "writer",
        ...(options.leaseId ? { "x-rakazo-screen-lease-id": options.leaseId } : {}),
      },
      body: JSON.stringify(body),
    });
  const releaseWarm = (leaseId: string) =>
    supervisorApp.request("/computers/computer/screen", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
        "x-rakazo-screen-id": "writer",
        "x-rakazo-screen-lease-id": leaseId,
        "x-rakazo-preserve-screen": "1",
      },
    });
  return { logError, screenMode, releaseWarm };
}

describe("idle Team Computer screens", () => {
  it("closes a run's screen 30 minutes after the run released it, and sets it up again on the next request", async () => {
    const { closes } = fixture();
    const { screenMode, releaseWarm } = await supervisor();
    const first = await screenMode(preview, { leaseId: "run-1:1" });
    expect(first.status).toBe(200);
    expect((await releaseWarm("run-1:1")).status).toBe(200);

    await vi.advanceTimersByTimeAsync(SCREEN_IDLE_MS - 1);
    expect(closes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(closes()).toHaveLength(1);

    const again = await screenMode(preview, { leaseId: "run-2:2" });
    expect(again.status).toBe(200);
    expect(await again.json()).not.toEqual(await first.json());
  });

  it("keeps an idle screen a run takes back, and closes it 30 minutes after that run releases it", async () => {
    const { closes } = fixture();
    const { screenMode, releaseWarm } = await supervisor();
    expect((await screenMode(preview, { leaseId: "run-1:1" })).status).toBe(200);
    expect((await releaseWarm("run-1:1")).status).toBe(200);
    await vi.advanceTimersByTimeAsync(20 * 60_000);

    expect((await screenMode(preview, { leaseId: "run-2:2" })).status).toBe(200);
    await vi.advanceTimersByTimeAsync(2 * SCREEN_IDLE_MS);
    expect(closes()).toHaveLength(0);

    expect((await releaseWarm("run-2:2")).status).toBe(200);
    await vi.advanceTimersByTimeAsync(SCREEN_IDLE_MS - 1);
    expect(closes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(closes()).toHaveLength(1);
  });

  it("does not close a screen a run took back while the close waited for the lock", async () => {
    const { computer, closes } = fixture();
    const { screenMode, releaseWarm } = await supervisor();
    const { withComputerScreenLock } = await import("./screens.js");
    expect((await screenMode(preview, { leaseId: "run-1:1" })).status).toBe(200);
    expect((await releaseWarm("run-1:1")).status).toBe(200);
    await vi.advanceTimersByTimeAsync(29 * 60_000);

    const gate = deferred<void>();
    computer.gate = gate;
    const taken = screenMode(preview, { leaseId: "run-2:2" });
    await vi.waitFor(() => expect(computer.gate).toBeUndefined());
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    gate.resolve();
    expect((await taken).status).toBe(200);
    await withComputerScreenLock("computer", async () => {});
    expect(closes()).toHaveLength(0);
  });

  it("preserves a failed cancellation when an idle close was waiting for the lock", async () => {
    const { computer, container } = fixture();
    const { screenMode, releaseWarm, logError } = await supervisor();
    const { computerScreens, withComputerScreenLock } = await import("./screens.js");
    expect((await screenMode(preview, { leaseId: "run-1:1" })).status).toBe(200);
    expect((await releaseWarm("run-1:1")).status).toBe(200);
    await vi.advanceTimersByTimeAsync(29 * 60_000);

    const started = deferred<void>();
    const gate = deferred<void>();
    const held = withComputerScreenLock("computer", async () => {
      started.resolve();
      await gate.promise;
      releaseAssignedScreen(computerScreens.get("computer")!, "writer");
    });
    await started.promise;
    computer.failInspect = true;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    container.inspect.mockClear();
    gate.resolve();
    await held;
    await withComputerScreenLock("computer", async () => {});
    expect(container.inspect).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
    expect(computerScreens.get("computer")?.get("writer")?.releasing).toBe(true);
  });

  it("keeps a controlled screen, and closes it 30 minutes after control is released", async () => {
    const { closes } = fixture();
    const { screenMode } = await supervisor();
    expect((await screenMode({ interactive: true, controlToken: "human-control" })).status).toBe(
      200,
    );
    await vi.advanceTimersByTimeAsync(2 * SCREEN_IDLE_MS);
    expect(closes()).toHaveLength(0);

    expect((await screenMode({ interactive: false })).status).toBe(200);
    await vi.advanceTimersByTimeAsync(SCREEN_IDLE_MS - 1);
    expect(closes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(closes()).toHaveLength(1);
  });

  it("closes a screen a preview opened 30 minutes later", async () => {
    const { closes } = fixture();
    const { screenMode } = await supervisor();
    expect((await screenMode(preview)).status).toBe(200);

    await vi.advanceTimersByTimeAsync(SCREEN_IDLE_MS - 1);
    expect(closes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(closes()).toHaveLength(1);
  });

  it("evicts a screen a preview opened once the Team screen limit is full", async () => {
    vi.stubEnv("SANDBOX_TEAM_SCREEN_LIMIT", "2");
    const { closes } = fixture();
    const { screenMode } = await supervisor();
    expect((await screenMode(preview, { screenId: "writer" })).status).toBe(200);
    expect((await screenMode(preview, { screenId: "researcher" })).status).toBe(200);

    expect((await screenMode(preview, { screenId: "newcomer" })).status).toBe(200);
    expect(closes()).toHaveLength(1);
    expect(closes()[0]).toContain("sockets/view-1-");
    expect(closes()[0]).not.toContain("sockets/view-2-");
  });

  it("leaves a screen alone once its computer has restarted", async () => {
    const { computer, closes } = fixture();
    const { screenMode, logError } = await supervisor();
    expect((await screenMode(preview)).status).toBe(200);

    computer.startedAt = "boot-2";
    await vi.advanceTimersByTimeAsync(SCREEN_IDLE_MS);
    expect(closes()).toHaveLength(0);
    expect(logError).not.toHaveBeenCalled();
  });

  it("forgets the idle screens of a computer that has stopped", async () => {
    const { computer, closes } = fixture();
    const { screenMode, logError } = await supervisor();
    expect((await screenMode(preview)).status).toBe(200);

    computer.running = false;
    await vi.advanceTimersByTimeAsync(SCREEN_IDLE_MS);
    expect(closes()).toHaveLength(0);
    expect(logError).not.toHaveBeenCalled();
  });

  it("tries again 30 minutes later when a close fails, without leaving the screen stuck", async () => {
    const { computer, closes } = fixture();
    const { screenMode, releaseWarm, logError } = await supervisor();
    expect((await screenMode(preview, { leaseId: "run-1:1" })).status).toBe(200);
    expect((await releaseWarm("run-1:1")).status).toBe(200);

    computer.failCloses = true;
    await vi.advanceTimersByTimeAsync(SCREEN_IDLE_MS);
    expect(closes()).toHaveLength(1);
    expect(logError).toHaveBeenCalledTimes(1);

    computer.failCloses = false;
    await vi.advanceTimersByTimeAsync(SCREEN_IDLE_MS - 1);
    expect(closes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(closes()).toHaveLength(2);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
