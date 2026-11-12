import { describe, expect, it, vi } from "vitest";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  userComputerAct,
  userComputerCwd,
  userComputerGate,
  userComputerList,
  userComputerObserve,
  userComputerOwner,
  userComputerShell,
} from "./run-tools-user-computer.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

const environment = { platform: "darwin", home: "/Users/fake", shell: "/bin/zsh" };

function setup(execute: (signal: AbortSignal) => AsyncIterable<unknown>, secrets: string[] = []) {
  const controller = new AbortController();
  const requests: HostComputerRequest[] = [];
  const signals: AbortSignal[] = [];
  const deviceIds: (string | undefined)[] = [];
  const gateway: UserDeviceGateway = {
    list: async () => [],
    connected: async () => ({ deviceId: "device-1", name: "Laptop", platform: "darwin" }),
    pairedSince: async () => new Date(0),
    async *request<T>(
      _userId: string,
      request: HostComputerRequest,
      signal: AbortSignal,
      deviceId?: string,
    ) {
      requests.push(request);
      deviceIds.push(deviceId);
      signals.push(signal);
      if (request.method === "provision") yield {} as T;
      else if (request.method === "environment") yield environment as T;
      else yield* execute(signal) as AsyncIterable<T>;
    },
  };
  const ctx = {
    deps: { userDevices: gateway },
    bot: { id: "bot-1" },
    runId: "run-1",
    source: { userComputerOwner: "user-1" },
    context: { signal: controller.signal },
    secrets,
  } as unknown as RunContext;
  const onShellStillRunning = vi.fn();
  const call = (args: Record<string, unknown>) =>
    ({
      name: "user_computer_shell",
      args,
      observer: { onShellStillRunning },
      finish: async (result: unknown) => result,
    }) as unknown as ToolCall;
  return { ctx, call, controller, requests, signals, deviceIds, onShellStillRunning };
}

describe("userComputerGate", () => {
  it("finds an app approved before hundreds of later screen actions", async () => {
    const effects = [
      ...Array.from({ length: 450 }, (_, index) => ({ id: `e${450 - index}`, app: "TextEdit" })),
      { id: "e0", app: "Mail" },
    ].map(({ id, app }) => ({ id, request: { app } }));
    const findMany = vi.fn(async ({ take, cursor }: { take: number; cursor?: { id: string } }) => {
      const start = cursor ? effects.findIndex((effect) => effect.id === cursor.id) + 1 : 0;
      return effects.slice(start, start + take);
    });
    const ctx = {
      deps: {
        userDevices: { pairedSince: async () => new Date(0) },
        prisma: { externalEffect: { findMany } },
      },
      run: { spaceId: "space-1", userId: "user-1" },
    } as unknown as RunContext;
    await expect(
      userComputerGate(ctx, false, "user_computer_observe", { app: "mail" }),
    ).resolves.toBe("allow");
    expect(findMany).toHaveBeenCalledTimes(3);
    await expect(
      userComputerGate(ctx, false, "user_computer_observe", { app: "Notes" }),
    ).resolves.toBe("ask");
  });
});

describe("userComputerOwner", () => {
  const own = {
    trigger: "user",
    sourceRole: "user",
    messagingChannelRun: false,
    runUserId: "user-1",
    botUserId: "user-1",
  };

  it("is the bot owner when their own message started the run", () => {
    expect(userComputerOwner(own)).toBe("user-1");
    expect(userComputerOwner({ ...own, trigger: "follow_up" })).toBe("user-1");
  });

  it.each([
    { trigger: "routine" },
    { trigger: "webhook" },
    { trigger: "messaging" },
    { trigger: "call_end" },
    { sourceRole: "bot" },
    { sourceRole: undefined },
    { messagingChannelRun: true },
    { runUserId: "user-2" },
  ])("is nobody for %o", (change) => {
    expect(userComputerOwner({ ...own, ...change })).toBeUndefined();
  });
});

describe("userComputerCwd", () => {
  it("defaults to home and resolves relative and ~ paths against it", () => {
    expect(userComputerCwd(environment, undefined)).toBe("/Users/fake");
    expect(userComputerCwd(environment, "~")).toBe("/Users/fake");
    expect(userComputerCwd(environment, "~/code")).toBe("/Users/fake/code");
    expect(userComputerCwd(environment, "code")).toBe("/Users/fake/code");
    expect(userComputerCwd(environment, "/Users/fake/code")).toBe("/Users/fake/code");
    expect(userComputerCwd(environment, "..cache")).toBe("/Users/fake/..cache");
    expect(() => userComputerCwd(environment, "/tmp")).toThrow("inside the user's home folder");
    expect(() => userComputerCwd(environment, "../other")).toThrow("inside the user's home folder");
    expect(
      userComputerCwd({ platform: "win32", home: "C:\\Users\\fake", shell: "pwsh" }, "code"),
    ).toBe("C:\\Users\\fake\\code");
  });
});

describe("userComputerShell", () => {
  it("streams the command's redacted output from the user's shell", async () => {
    const { ctx, call, requests, deviceIds } = setup(
      async function* () {
        yield { type: "stdout", data: "token=sk-fake-secret\n" };
        yield { type: "stderr", data: "warning\n" };
        yield { type: "exit", code: 2 };
      },
      ["sk-fake-secret"],
    );
    const result = (await userComputerShell(ctx, call({ command: "cat .env", cwd: "app" }))) as {
      stdout: string;
      stderr: string;
      code: number;
    };
    expect(result.stdout).not.toContain("sk-fake-secret");
    expect(result).toMatchObject({ stderr: "warning\n", code: 2 });
    expect(deviceIds).toEqual(["device-1", "device-1", "device-1"]);
    expect(requests).toEqual([
      { method: "provision", botId: "bot-1", runId: "run-1" },
      { method: "environment", botId: "bot-1", runId: "run-1" },
      {
        method: "execute",
        botId: "bot-1",
        runId: "run-1",
        command: expect.objectContaining({
          argv: ["/bin/zsh", "-lc", "cat .env"],
          cwd: "/Users/fake/app",
        }),
      },
    ]);
  });

  it("returns a quiet sign-in prompt early and keeps collecting its output", async () => {
    let finish!: () => void;
    const exited = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.useFakeTimers();
    try {
      const { ctx, call, onShellStillRunning } = setup(async function* () {
        yield { type: "stdout", data: "Enter code ABCD-1234 at https://example.com/device\n" };
        await exited;
        yield { type: "exit", code: 0 };
      });
      const pending = userComputerShell(ctx, call({ command: "gh auth login" }));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toMatchObject({
        stdout: "Enter code ABCD-1234 at https://example.com/device\n",
        running: true,
      });
      expect(onShellStillRunning).toHaveBeenCalledOnce();
      finish();
      await expect(onShellStillRunning.mock.calls[0]![0]).resolves.toMatchObject({ code: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a device that drops mid-command as an error result", async () => {
    const { ctx, call } = setup(async function* () {
      yield* [];
      throw new Error("Device disconnected");
    });
    expect(await userComputerShell(ctx, call({ command: "ls" }))).toEqual({
      error: "The user's computer did not finish the command: Device disconnected",
    });
  });

  it("passes the run's abort to the device and rethrows it", async () => {
    const { ctx, call, controller, signals } = setup(async function* (signal) {
      yield* [];
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("aborted");
    });
    const pending = userComputerShell(ctx, call({ command: "sleep 100" }));
    await vi.waitFor(() => expect(signals).toHaveLength(3));
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe("explicit computer targeting", () => {
  it("pins every shell request to the selected computer", async () => {
    const { ctx, call, deviceIds } = setup(async function* () {
      yield { type: "exit", code: 0 };
    });
    const connected = vi.fn(async (_owner: string, id?: string) => ({
      deviceId: id ?? "device-1",
      name: "Desk PC",
      platform: "linux",
    }));
    ctx.deps.userDevices!.connected = connected;
    await userComputerShell(ctx, call({ command: "pwd", computerId: "device-2" }));
    expect(connected).toHaveBeenCalledWith("user-1", "device-2");
    expect(deviceIds).toEqual(["device-2", "device-2", "device-2"]);
  });

  it.each([userComputerObserve, userComputerAct])(
    "pins screen requests to the selected computer",
    async (tool) => {
      const { ctx, call, deviceIds } = setup(async function* () {
        yield { app: "Notes", tree: "Window", completed: 1 };
      });
      ctx.computer = { acceptsImages: false } as RunContext["computer"];
      ctx.deps.userDevices!.connected = vi.fn(async (_owner, id) => ({
        deviceId: id!,
        name: "Desk PC",
        platform: "darwin",
      }));
      await tool(
        ctx,
        call({ app: "Notes", actions: [{ kind: "wait", ms: 1 }], computerId: "device-2" }),
      );
      expect(deviceIds).toEqual(["device-2"]);
    },
  );

  it.each([userComputerShell, userComputerObserve, userComputerAct])(
    "refuses unavailable targets without requests",
    async (tool) => {
      const { ctx, call, requests } = setup(async function* () {});
      ctx.deps.userDevices!.connected = vi.fn(async () => null);
      const result = await tool(
        ctx,
        call({
          command: "pwd",
          app: "Notes",
          actions: [{ kind: "wait", ms: 1 }],
          computerId: "missing",
        }),
      );
      expect(result).toMatchObject({ error: expect.stringContaining("selected computer") });
      expect(requests).toEqual([]);
    },
  );

  it.each(["", null, 42])(
    "rejects malformed ids (%s) instead of using the default",
    async (computerId) => {
      const { ctx, call, requests } = setup(async function* () {});
      expect(await userComputerShell(ctx, call({ command: "pwd", computerId }))).toMatchObject({
        error: expect.stringContaining("computerId"),
      });
      expect(requests).toEqual([]);
    },
  );

  it("lists only the owner's connected computers, with the omitted-id binding", async () => {
    const { ctx, call } = setup(async function* () {});
    ctx.deps.userDevices!.list = vi.fn(async () => [
      { deviceId: "d1", name: "Laptop", connected: true, bound: false },
      { deviceId: "d2", name: "Desk PC", connected: true, bound: true },
      { deviceId: "d3", name: "Offline PC", connected: false },
    ]);
    expect(await userComputerList(ctx, call({}))).toEqual({
      computers: [
        { computerId: "d1", name: "Laptop", bound: false },
        { computerId: "d2", name: "Desk PC", bound: true },
      ],
    });
    expect(ctx.deps.userDevices!.list).toHaveBeenCalledWith("user-1");
    ctx.source.userComputerOwner = undefined;
    expect(await userComputerList(ctx, call({}))).toHaveProperty("error");
  });
});
