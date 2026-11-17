import type { AdapterContext } from "@rakazo/adapter-kit";
import type * as adapters from "@rakazo/adapters";
import { BrowserStoppedReleaseError, FakeSandboxProvider } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { restartBotScreen } from "./computer-control.js";
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

const computerRow = {
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
    computer?: Partial<typeof computerRow> | null;
    working?: boolean;
    releaseScreen?: ReturnType<typeof vi.fn> | null;
  } = {},
) {
  const computer = options.computer === null ? null : { ...computerRow, ...options.computer };
  const prisma = {
    spaceMember: { count: vi.fn(async () => 1) },
    bot: {
      findFirst: vi.fn().mockResolvedValue({
        id: "bot-1",
        name: "Bot",
        thread: { id: "thread-1" },
        computer,
      }),
    },
    run: { findFirst: vi.fn().mockResolvedValue(options.working ? { id: "run-1" } : null) },
    computerExecutionLease: { findUnique: vi.fn().mockResolvedValue(null) },
    computer: { updateMany: vi.fn() },
  } as unknown as PrismaClient;
  const releaseScreen =
    options.releaseScreen === null ? undefined : (options.releaseScreen ?? vi.fn());
  const deps = { prisma, sandbox: { releaseScreen } } as unknown as RouterDeps;
  return { deps, prisma, releaseScreen };
}

beforeEach(() => {
  lifecycle.acquire.mockReset().mockResolvedValue(lease);
  lifecycle.release.mockReset().mockResolvedValue(undefined);
});

describe("restartBotScreen", () => {
  it("tears down this bot's browser and lets go of the lease", async () => {
    const { deps, releaseScreen } = setup();
    await restartBotScreen(deps, { actor }, "bot-1");
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
    const { deps } = setup({
      releaseScreen: vi.fn().mockRejectedValue(new Error("supervisor unreachable")),
    });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).rejects.toThrow(
      "supervisor unreachable",
    );
    expect(lifecycle.release).toHaveBeenCalledWith(deps.prisma, lease);
  });

  it("counts a browser that stopped before its slot could be cleared as restarted", async () => {
    const { deps } = setup({
      releaseScreen: vi.fn().mockRejectedValue(new BrowserStoppedReleaseError()),
    });
    await expect(restartBotScreen(deps, { actor }, "bot-1")).resolves.toMatchObject({
      botId: "bot-1",
    });
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
});
