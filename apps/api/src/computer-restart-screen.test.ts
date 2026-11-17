import type { AdapterContext } from "@rakazo/adapter-kit";
import type * as adapters from "@rakazo/adapters";
import {
  BrowserStoppedReleaseError,
  ComputerBusyError,
  FakeSandboxProvider,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { restartBotScreen, takeComputerControl } from "./computer-control.js";
import type { RouterDeps } from "./router.js";

const lifecycle = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof adapters>()),
  acquireComputerExecutionLease: lifecycle.acquire,
  releaseComputerExecutionLease: lifecycle.release,
}));

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: true,
} satisfies Actor;

const lease = { computerId: "computer-1", botId: "bot-1", runId: "screen:x", fence: 4 };

type ComputerRow = {
  id: string;
  spaceId: string;
  kind: string;
  scope: string;
  state: string;
  providerRef: string | null;
  homeKey: string;
  controlHolder: string;
  controlLeaseId: string | null;
  controlLeaseExpiresAt: Date | null;
  controlBotId: string | null;
  controlUserId: string | null;
};

const computerRow: ComputerRow = {
  id: "computer-1",
  spaceId: "space-1",
  kind: "fake",
  scope: "team",
  state: "running",
  providerRef: "fake-box",
  homeKey: "home-1",
  controlHolder: "none",
  controlLeaseId: null,
  controlLeaseExpiresAt: null,
  controlBotId: null,
  controlUserId: null,
};

function setup(
  options: {
    computer?: Partial<ComputerRow> | null;
    // What the read after the lease sees, when it differs from the first read.
    later?: Partial<ComputerRow> | null;
    working?: boolean;
    releaseScreen?: ReturnType<typeof vi.fn> | null;
  } = {},
) {
  const computer = options.computer === null ? null : { ...computerRow, ...options.computer };
  const bot = (row: ComputerRow | null) => ({
    id: "bot-1",
    name: "Bot",
    thread: { id: "thread-1" },
    computer: row,
  });
  const findFirst = vi.fn().mockResolvedValue(bot(computer));
  if (options.later !== undefined) {
    findFirst
      .mockResolvedValueOnce(bot(computer))
      .mockResolvedValue(bot(options.later === null ? null : { ...computerRow, ...options.later }));
  }
  const prisma = {
    spaceMember: { count: vi.fn(async () => 1) },
    bot: { findFirst },
    run: {
      findFirst: vi.fn().mockResolvedValue(options.working ? { id: "run-1" } : null),
      findUnique: vi.fn().mockResolvedValue({ status: "completed" }),
    },
    computerExecutionLease: {
      findUnique: vi.fn().mockResolvedValue({
        runId: "run-just-stopped",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    },
    computer: { updateMany: vi.fn() },
  } as unknown as PrismaClient;
  const releaseScreen =
    options.releaseScreen === null ? undefined : (options.releaseScreen ?? vi.fn());
  const capture = vi.fn();
  const deps = {
    prisma,
    sandbox: { releaseScreen },
    analytics: { capture },
  } as unknown as RouterDeps;
  return { deps, prisma, releaseScreen, capture };
}

beforeEach(() => {
  lifecycle.acquire.mockReset().mockResolvedValue(lease);
  lifecycle.release.mockReset().mockResolvedValue(undefined);
});

describe("restartBotScreen", () => {
  it("tears down this bot's browser and lets go of the lease", async () => {
    const { deps, releaseScreen, capture } = setup();
    await restartBotScreen(deps, { actor }, "bot-1");
    expect(capture).toHaveBeenCalledExactlyOnceWith(actor.userId, {
      name: "computer_repair_started",
      action: "restartScreen",
    });
    expect(releaseScreen).toHaveBeenCalledOnce();
    const [ref, context] = (releaseScreen as NonNullable<typeof releaseScreen>).mock.calls[0] as [
      { id: string },
      AdapterContext,
    ];
    expect(ref).toMatchObject({ providerRef: "fake-box" });
    expect(context).toMatchObject({ botId: "bot-1", cancelRunWork: true });
    // A fence naming another owner would be refused as stale and stop nothing.
    expect(context.screenLeaseId).toBeUndefined();
    expect(lifecycle.release).toHaveBeenCalledWith(deps.prisma, lease);
  });

  it("waits out the lease of a run that was just stopped instead of answering busy", async () => {
    lifecycle.acquire.mockRejectedValueOnce(new ComputerBusyError()).mockResolvedValue(lease);
    const { deps, releaseScreen } = setup();
    await restartBotScreen(deps, { actor }, "bot-1");
    expect(lifecycle.acquire).toHaveBeenCalledTimes(2);
    expect(releaseScreen).toHaveBeenCalledOnce();
  });

  it("stays busy when a run that is still active holds the lease", async () => {
    lifecycle.acquire.mockRejectedValue(new ComputerBusyError());
    const { deps, releaseScreen, prisma } = setup();
    (prisma.run.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "running" });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(lifecycle.acquire).toHaveBeenCalledOnce();
    expect(releaseScreen).not.toHaveBeenCalled();
  });

  it("really clears a screen last held by an earlier run", async () => {
    const sandbox = new FakeSandboxProvider();
    const context = {
      operationId: "boot",
      traceId: "boot",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      screenLeaseId: "run-old:2",
      signal: new AbortController().signal,
    } satisfies AdapterContext;
    const ref = await sandbox.provision({ botId: "bot-1", homePath: "/tmp/x" }, context);
    await sandbox.connectScreen(ref, { view: "stream", interactive: false }, context);
    const box = sandbox.boxes.get(ref.id);
    expect(box?.screens.has("bot-1")).toBe(true);

    const { prisma } = setup({ computer: { providerRef: ref.id } });
    const deps = { prisma, sandbox } as unknown as RouterDeps;
    await restartBotScreen(deps, { actor }, "bot-1");

    expect(box?.screens.has("bot-1")).toBe(false);
    sandbox.close();
  });

  it("leaves a bot that is working, or waiting at its screen, alone", async () => {
    const { deps, releaseScreen } = setup({ working: true });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(lifecycle.acquire).not.toHaveBeenCalled();
    expect(releaseScreen).not.toHaveBeenCalled();
  });

  it("refuses when a run appears between the first check and holding the lease", async () => {
    const { deps, prisma, releaseScreen } = setup();
    (prisma.run.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "run-paused" });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(lifecycle.acquire).toHaveBeenCalledOnce();
    expect(releaseScreen).not.toHaveBeenCalled();
    expect(lifecycle.release).toHaveBeenCalledWith(deps.prisma, lease);
  });

  it("refuses a computer that is not a Team computer", async () => {
    const { deps, releaseScreen } = setup({ computer: { scope: "dedicated" } });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(releaseScreen).not.toHaveBeenCalled();
  });

  it("refuses a computer whose provider cannot release one screen", async () => {
    const { deps } = setup({ releaseScreen: null });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(lifecycle.acquire).not.toHaveBeenCalled();
  });

  it("refuses a kind that does not declare the capability, even behind a wrapper with releaseScreen", async () => {
    const { deps, releaseScreen } = setup({ computer: { kind: "wuying" } });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(releaseScreen).not.toHaveBeenCalled();
    expect(lifecycle.acquire).not.toHaveBeenCalled();
  });

  it("does nothing to a computer that is not running", async () => {
    const { deps, releaseScreen } = setup({ computer: { state: "stopped", providerRef: null } });
    await restartBotScreen(deps, { actor }, "bot-1");
    expect(releaseScreen).not.toHaveBeenCalled();
    expect(lifecycle.acquire).not.toHaveBeenCalled();
  });

  it("lets go of the lease when the teardown fails, and reports the failure", async () => {
    const { deps, capture } = setup({
      releaseScreen: vi.fn().mockRejectedValue(new Error("supervisor unreachable")),
    });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toThrow(
      "supervisor unreachable",
    );
    expect(capture).not.toHaveBeenCalled();
    expect(lifecycle.release).toHaveBeenCalledWith(deps.prisma, lease);
  });

  it("counts a browser that stopped before its slot could be cleared as restarted", async () => {
    const { deps, capture } = setup({
      releaseScreen: vi.fn().mockRejectedValue(new BrowserStoppedReleaseError()),
    });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).resolves.toMatchObject({
      botId: "bot-1",
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(lifecycle.release).toHaveBeenCalledWith(deps.prisma, lease);
  });

  it("stays refused while someone else holds the computer", async () => {
    const { deps, releaseScreen } = setup({
      computer: {
        controlHolder: "user",
        controlLeaseId: "lease-9",
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        controlBotId: "bot-1",
        controlUserId: "someone-else",
      },
    });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(releaseScreen).not.toHaveBeenCalled();
  });

  it("counts nothing when the sandbox turns out to be gone", async () => {
    const { deps, capture } = setup({
      releaseScreen: vi.fn().mockRejectedValue(new Error("sandbox not found")),
    });
    (deps.prisma.computer.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).resolves.toMatchObject({
      botId: "bot-1",
    });
    expect(capture).not.toHaveBeenCalled();
    expect(lifecycle.release).toHaveBeenCalledWith(deps.prisma, lease);
  });

  it("refuses to tear the screen down while this person's own control is still on it", async () => {
    const own = {
      controlHolder: "user",
      controlLeaseId: "lease-1",
      controlLeaseExpiresAt: new Date(Date.now() + 60_000),
      controlBotId: "bot-1",
      controlUserId: actor.userId,
    };
    const { deps, releaseScreen, capture } = setup({ computer: own, later: own });
    // The hand back is refused, as when the lease was renewed or ended meanwhile.
    (deps.events as unknown) = { releaseUserControl: vi.fn().mockResolvedValue(false) };
    (deps as { sandbox: unknown }).sandbox = { releaseScreen, setScreenControl: vi.fn() };
    (deps as { jobs: unknown }).jobs = { cancel: vi.fn(), enqueue: vi.fn() };
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(releaseScreen).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(lifecycle.release).toHaveBeenCalledWith(deps.prisma, lease);
  });

  it("hands back control this person took after the first read, before tearing the screen down", async () => {
    const own = {
      controlHolder: "user",
      controlLeaseId: "lease-1",
      controlLeaseExpiresAt: new Date(Date.now() + 60_000),
      controlBotId: "bot-1",
      controlUserId: actor.userId,
    };
    // Reads: before the lease (no control), under the lease (taken since), after the hand back.
    const { deps, prisma, releaseScreen } = setup();
    const bot = (row: ComputerRow) => ({
      id: "bot-1",
      name: "Bot",
      thread: { id: "thread-1" },
      computer: row,
    });
    (prisma.bot.findFirst as unknown as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValueOnce(bot(computerRow))
      .mockResolvedValueOnce(bot({ ...computerRow, ...own }))
      .mockResolvedValue(bot(computerRow));
    const releaseUserControl = vi.fn().mockResolvedValue(true);
    (deps as { events: unknown }).events = { releaseUserControl };
    (deps as { sandbox: unknown }).sandbox = { releaseScreen, setScreenControl: vi.fn() };
    (deps as { jobs: unknown }).jobs = {
      cancel: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn().mockResolvedValue(undefined),
    };
    await restartBotScreen(deps, { actor }, "bot-1");
    expect(releaseUserControl).toHaveBeenCalledOnce();
    expect(releaseScreen).toHaveBeenCalledOnce();
  });

  it("refuses a computer that is going to sleep instead of answering as if it restarted", async () => {
    const { deps, releaseScreen } = setup({ computer: { state: "suspending" } });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(releaseScreen).not.toHaveBeenCalled();
    expect(lifecycle.acquire).not.toHaveBeenCalled();
  });

  it("refuses a computer that is still booting", async () => {
    const { deps, releaseScreen } = setup({ computer: { state: "booting" } });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(releaseScreen).not.toHaveBeenCalled();
  });

  it("does not tear down a screen someone else took while the lease was being acquired", async () => {
    const { deps, releaseScreen } = setup({
      later: {
        controlHolder: "user",
        controlLeaseId: "lease-9",
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        controlBotId: "bot-1",
        controlUserId: "someone-else",
      },
    });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(releaseScreen).not.toHaveBeenCalled();
    expect(lifecycle.release).toHaveBeenCalledWith(deps.prisma, lease);
  });

  it("does not tear down a computer that went to sleep while the lease was being acquired", async () => {
    const { deps, releaseScreen } = setup({ later: { state: "suspending" } });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(releaseScreen).not.toHaveBeenCalled();
    expect(lifecycle.release).toHaveBeenCalledWith(deps.prisma, lease);
  });

  it("leaves a computer that stopped meanwhile alone and lets go of the lease", async () => {
    const { deps, releaseScreen, capture } = setup({
      later: { state: "stopped", providerRef: null },
    });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).resolves.toMatchObject({
      botId: "bot-1",
    });
    expect(releaseScreen).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(lifecycle.release).toHaveBeenCalledWith(deps.prisma, lease);
  });
});

describe("takeComputerControl during a screen restart", () => {
  const own = {
    controlHolder: "user",
    controlLeaseId: "lease-1",
    controlLeaseExpiresAt: new Date(Date.now() + 60_000),
    controlBotId: "bot-1",
    controlUserId: actor.userId,
  };

  // The database refuses any update that carries the restart-lease condition while one is live.
  function holderTakingOver() {
    const { deps, prisma } = setup({ computer: own });
    const updateMany = vi.fn(async ({ where }: { where: { executionLeases?: unknown } }) => ({
      count: where.executionLeases ? 0 : 1,
    }));
    (prisma.computer as unknown as { updateMany: unknown }).updateMany = updateMany;
    (prisma.computer as unknown as { findUniqueOrThrow: unknown }).findUniqueOrThrow = vi
      .fn()
      .mockResolvedValue({ ...computerRow, ...own, id: "computer-1" });
    (deps as { events: unknown }).events = { releaseUserControl: vi.fn().mockResolvedValue(true) };
    (deps as { sandbox: unknown }).sandbox = { setScreenControl: vi.fn() };
    (deps as { jobs: unknown }).jobs = {
      cancel: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn().mockResolvedValue(undefined),
    };
    return { deps, updateMany };
  }

  it("does not renew the holder's lease while a restart holds this bot's screen", async () => {
    const { deps, updateMany } = holderTakingOver();
    await expect(takeComputerControl(deps, actor, "bot-1")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const renewals = updateMany.mock.calls.filter(([{ where }]) =>
      Object.hasOwn(where, "controlLeaseExpiresAt"),
    );
    expect(renewals.length).toBeGreaterThan(0);
    for (const [{ where }] of renewals) {
      expect(where).toMatchObject({
        executionLeases: {
          none: { botId: "bot-1", runId: { startsWith: "screen:" } },
        },
      });
    }
  });
});
