import { ComputerStatusSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { resolveComputerWork, toComputerStatus } from "./computer-status.js";

describe("toComputerStatus", () => {
  it("shows a quarantined computer as an error without making its screen available", () => {
    expect(
      toComputerStatus("bot", {
        kind: "novita",
        state: "quarantined",
        scope: "team",
        controlHolder: "none",
        homeRevision: "saved",
      }),
    ).toMatchObject({ state: "error", screenAvailable: false });
  });
  it("reads a computer whose provider this build does not have without throwing", () => {
    const status = toComputerStatus("bot", {
      kind: "a-provider-since-removed",
      state: "stopped",
      scope: "team",
      controlHolder: "none",
      homeRevision: "saved",
    });
    expect(ComputerStatusSchema.parse(status)).toMatchObject({
      kind: "a-provider-since-removed",
      state: "stopped",
      screenAvailable: false,
      terminalAvailable: false,
    });
    expect(status.runsOnUserMachine).toBeUndefined();
  });
  it("says when the computer is the person's own machine", () => {
    const computer = { state: "running", scope: "team", controlHolder: "none", homeRevision: "r" };
    expect(toComputerStatus("bot", { ...computer, kind: "desktop" }).runsOnUserMachine).toBe(true);
    expect(toComputerStatus("bot", { ...computer, kind: "docker" })).not.toHaveProperty(
      "runsOnUserMachine",
    );
  });
  it("warns at 90% full until the user hides it, and again once the disk fills further", () => {
    const computer = {
      kind: "docker",
      state: "running",
      scope: "team",
      controlHolder: "none",
      homeRevision: "saved",
      diskUsedBytes: 91n,
      diskFreeBytes: 9n,
    };
    const status = (changes: object) => toComputerStatus("bot", { ...computer, ...changes });
    expect(status({}).diskFullPercent).toBe(91);
    expect(ComputerStatusSchema.parse(status({})).diskFullPercent).toBe(91);
    expect(status({ diskUsedBytes: 89n, diskFreeBytes: 11n }).diskFullPercent).toBeUndefined();
    expect(status({ diskDismissedPercent: 91 }).diskFullPercent).toBeUndefined();
    expect(status({ diskDismissedPercent: 90 }).diskFullPercent).toBe(91);
    expect(status({ diskUsedBytes: null }).diskFullPercent).toBeUndefined();
  });
  it("passes through what the bot is doing with its computer", () => {
    const computer = {
      kind: "fake",
      state: "running",
      scope: "team",
      controlHolder: "none",
      homeRevision: "revision-1",
    };
    expect(toComputerStatus("bot-1", computer)).toMatchObject({
      busyBotName: null,
      takeoverRequested: false,
    });
    expect(
      toComputerStatus("bot-1", computer, { busyBotName: "Writer", takeoverRequested: true }),
    ).toMatchObject({ busyBotName: "Writer", takeoverRequested: true });
  });

  it("tells only the person holding control their own lease", () => {
    const computer = {
      kind: "fake",
      state: "running",
      scope: "team",
      controlHolder: "user",
      controlBotId: "bot-1",
      controlLeaseId: "lease-1",
      controlUserId: "user-1",
      userId: "owner",
      homeRevision: "revision-1",
    };
    expect(toComputerStatus("bot-1", computer, undefined, true, "user-1").controlLeaseId).toBe(
      "lease-1",
    );
    // Another bot's screen on the same Team computer is not this lease's.
    expect(
      toComputerStatus("bot-2", computer, undefined, true, "user-1").controlLeaseId,
    ).toBeUndefined();
    const watcher = toComputerStatus("bot-1", computer, undefined, true, "user-2");
    expect(watcher.controlLeaseId).toBeUndefined();
    expect(watcher.controlledByOther).toBe(true);
  });

  it("sandbox-none-computer-status", () => {
    const stopped = toComputerStatus("bot-1", {
      kind: "none",
      state: "stopped",
      scope: "team",
      controlHolder: "none",
      homeRevision: "empty",
    });
    expect(ComputerStatusSchema.parse(stopped)).toMatchObject({
      kind: "none",
      state: "stopped",
      canUpdate: false,
      terminalAvailable: false,
      screenAvailable: false,
    });

    const running = toComputerStatus("bot-1", {
      kind: "none",
      state: "running",
      scope: "team",
      controlHolder: "none",
      homeRevision: "empty",
    });
    expect(ComputerStatusSchema.parse(running)).toMatchObject({
      state: "stopped",
      canUpdate: false,
      terminalAvailable: false,
      screenAvailable: false,
    });
  });

  it.each(["boxd", "railway"])("offers the terminal on a %s computer", (kind) => {
    expect(
      toComputerStatus("bot-1", {
        kind,
        state: "running",
        scope: "team",
        controlHolder: "none",
        homeRevision: "r1",
      }).terminalAvailable,
    ).toBe(true);
  });

  it("hides update on desktop computers", () => {
    expect(
      toComputerStatus("bot-1", {
        kind: "desktop",
        state: "running",
        scope: "team",
        controlHolder: "none",
        homeRevision: "r1",
      }).canUpdate,
    ).toBe(false);
    expect(
      toComputerStatus("bot-1", {
        kind: "e2b",
        state: "running",
        scope: "team",
        controlHolder: "none",
        homeRevision: "r1",
      }).canUpdate,
    ).toBe(true);
  });
});

describe("resolveComputerWork", () => {
  const work = (lease: { runId: string; live: boolean } | null, runStatus?: string) =>
    resolveComputerWork(
      {
        computerExecutionLease: {
          findUnique: async () =>
            lease && {
              runId: lease.runId,
              expiresAt: new Date(Date.now() + (lease.live ? 60_000 : -60_000)),
            },
        },
        run: {
          findFirst: async () =>
            runStatus === "waiting_takeover" ? { id: "run-1", userId: "user-2" } : null,
          findUnique: async () => (runStatus ? { status: runStatus } : null),
        },
      } as unknown as Parameters<typeof resolveComputerWork>[0],
      { computerId: "computer-1", botId: "bot-1", botName: "Writer" },
    );

  it.each(["queued", "running"])(
    "names the bot while its %s run holds the computer",
    async (status) => {
      expect((await work({ runId: "run-1", live: true }, status)).busyBotName).toBe("Writer");
      expect((await work({ runId: "run-1", live: false }, status)).busyBotName).toBe("Writer");
    },
  );

  // The run row turns terminal before its executor releases the lease.
  it.each(["completed", "failed", "cancelled"])(
    "is free once the run is %s, even before its lease is released",
    async (status) => {
      expect(await work({ runId: "run-1", live: true }, status)).toEqual({
        busyBotName: null,
        takeoverRequested: false,
        takeoverUserId: null,
      });
    },
  );

  it("names the bot while a reset, update or teaching session holds the computer", async () => {
    expect((await work({ runId: "reset:1", live: true })).busyBotName).toBe("Writer");
    expect((await work({ runId: "reset:1", live: false })).busyBotName).toBeNull();
  });

  it("is free and asks for a person while the run waits on takeover", async () => {
    expect(await work({ runId: "run-1", live: true }, "waiting_takeover")).toEqual({
      busyBotName: null,
      takeoverRequested: true,
      takeoverUserId: "user-2",
    });
  });

  it("offers Skip and I'm done only to the person the bot asked", async () => {
    const computer = {
      kind: "fake",
      state: "running",
      scope: "team",
      controlHolder: "user",
      controlBotId: "bot-1",
      controlLeaseId: "lease-1",
      controlUserId: "user-1",
      userId: "owner",
      homeRevision: "revision-1",
    };
    const waiting = await work({ runId: "run-1", live: true }, "waiting_takeover");
    const requestedTo = (viewerId: string) =>
      toComputerStatus("bot-1", computer, waiting, true, viewerId).takeoverRequested;
    // user-1 holds the screen but was not asked: Hand back control, not Skip / I'm done.
    expect(requestedTo("user-1")).toBe(false);
    expect(requestedTo("user-2")).toBe(true);
    // Without a viewer the status reports the request as before.
    expect(toComputerStatus("bot-1", computer, waiting).takeoverRequested).toBe(true);
  });

  it("is free with no lease", async () => {
    expect((await work(null)).busyBotName).toBeNull();
  });
});
