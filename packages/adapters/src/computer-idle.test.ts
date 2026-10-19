import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_WORK_LAUNCH,
  BACKGROUND_WORK_PROBE,
  CANCEL_COMPUTER_RUN_WORK,
  CANCEL_PRIMARY_BROWSER_WORK,
  computerIdleSleepEnabled,
  computerMaxActiveMs,
  DEFAULT_COMPUTER_MAX_ACTIVE_MS,
  DEFAULT_SANDBOX_IDLE_MS,
  sandboxIdleMs,
  scheduleComputerSleep,
  sleepComputerIfIdle,
  touchRunningComputer,
} from "./computer-idle.js";
import { e2bCreateOptions } from "./e2b-sandbox.js";

describe("sandbox idle", () => {
  beforeEach(() => {
    vi.stubEnv("SANDBOX_IDLE_MS", undefined);
    vi.stubEnv("COMPUTER_MAX_ACTIVE_MS", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("defaults to ten minutes when SANDBOX_IDLE_MS is unset", () => {
    expect(computerIdleSleepEnabled()).toBe(true);
    expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
    expect(DEFAULT_SANDBOX_IDLE_MS).toBe(10 * 60 * 1000);
  });

  it.each(["0", " \t0\n"])("disables idle sleep for %j", async (value) => {
    vi.stubEnv("SANDBOX_IDLE_MS", value);
    const harness = idleHarness();

    expect(computerIdleSleepEnabled()).toBe(false);
    expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
    scheduleComputerSleep(harness.deps.jobs, harness.computer.id);
    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("running");
    expect(harness.prisma.computer.findUnique).not.toHaveBeenCalled();
    expect(harness.prisma.computer.updateMany).not.toHaveBeenCalled();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
  });

  it.each(["", "invalid", "NaN", "Infinity", "-1", "29999", "00", "0.0"])(
    "keeps idle sleep enabled with the default timeout for %j",
    (value) => {
      vi.stubEnv("SANDBOX_IDLE_MS", value);

      expect(computerIdleSleepEnabled()).toBe(true);
      expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
    },
  );

  it.each(["30000", "900000"])("schedules idle sleep using %s ms", (value) => {
    vi.stubEnv("SANDBOX_IDLE_MS", value);
    const harness = idleHarness();
    const now = new Date("2026-01-01T00:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);

    expect(computerIdleSleepEnabled()).toBe(true);
    expect(sandboxIdleMs()).toBe(Number(value));
    scheduleComputerSleep(harness.deps.jobs, harness.computer.id);

    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(now + Number(value)) }),
    );
  });

  it("does not suspend a computer while a run is active", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValueOnce({ id: "run" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("does not suspend a computer while bot-launched background work is active", async () => {
    const harness = idleHarness({ backgroundWorkProbeCode: 0 });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("probes background work with the database computer id, not providerRef", async () => {
    const harness = idleHarness({ backgroundWorkProbeCode: 0 });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: harness.computer.providerRef }),
      expect.objectContaining({
        argv: ["bash", "-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", harness.computer.id],
      }),
      expect.anything(),
    );
    expect(harness.computer.id).not.toBe(harness.computer.providerRef);
  });

  it("fails closed when the provider cannot inspect background work", async () => {
    const harness = idleHarness({ backgroundWorkProbeCode: 2 });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("fails closed when the provider reports a command failure as exit one", async () => {
    const harness = idleHarness({ backgroundWorkProbeFailed: true });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("does not let an abandoned waiting takeover prevent idle suspension", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
      where.status.in.includes("waiting_takeover") ? { id: "waiting" } : null,
    );

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("claims the lease boundary before any checkpoint export", async () => {
    const harness = idleHarness();
    harness.prisma.computer.updateMany.mockResolvedValueOnce({ count: 0 });
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.exportWorkspace).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
  });

  it("rechecks background work after checkpointing before it suspends", async () => {
    const harness = idleHarness({ backgroundWorkProbeCodes: [1, 0] });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.execute).toHaveBeenCalledTimes(2);
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("uses provider-native idle inspection instead of retaining emulator computers", async () => {
    const harness = idleHarness({ providerBackgroundWorkStatus: "idle" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.inspectBackgroundWork).toHaveBeenCalledTimes(2);
    expect(harness.sandbox.execute).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("checkpoints before suspending a stable idle computer", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      harness.sandbox.exportWorkspace.mock.invocationCallOrder[0]!,
    );
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.update).toHaveBeenCalledWith({
      where: {
        id: harness.computer.id,
        state: "suspending",
        providerRef: harness.computer.providerRef,
        updatedAt: expect.any(Date),
      },
      data: {
        state: "suspended",
        runningSince: null,
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    expect(harness.events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "computer.status", payload: { status: "suspended" } }),
    );
  });

  it("never stops the computer when checkpoint export fails", async () => {
    const harness = idleHarness({ exportError: new Error("checkpoint unavailable") });
    harness.prisma.run.findFirst.mockResolvedValueOnce(null);

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "checkpoint unavailable",
    );

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
  });

  it("stops a computer whose sandbox is gone instead of retrying the checkpoint", async () => {
    const gone = Object.assign(new Error("Paused sandbox computer not found"), {
      name: "SandboxNotFoundError",
    });
    const harness = idleHarness({ exportError: gone });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.computer.state).toBe("stopped");
    expect(harness.computer.providerRef).toBeNull();
    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("stops a computer whose sandbox is gone before the background-work probe", async () => {
    const gone = Object.assign(new Error("Paused sandbox computer not found"), {
      name: "SandboxNotFoundError",
    });
    const harness = idleHarness({ probeError: gone, exportError: gone });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.computer.state).toBe("stopped");
    expect(harness.computer.providerRef).toBeNull();
    expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("retains the saved revision when the database transition after stopping fails", async () => {
    const harness = idleHarness();
    harness.prisma.computer.update.mockRejectedValueOnce(new Error("database unavailable"));
    harness.sandbox.stop.mockImplementationOnce(async () => {
      expect(harness.computer.homeRevision).toBe("rev-checkpoint");
    });

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "database unavailable",
    );

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.computer.homeRevision).toBe("rev-checkpoint");
  });

  it.each(["failure", "lost claim"])(
    "does not stop when recording the revision encounters a %s",
    async (outcome) => {
      const harness = idleHarness();
      const updateMany = harness.prisma.computer.updateMany.getMockImplementation()!;
      harness.prisma.computer.updateMany.mockImplementation(async (args) => {
        if (args.data.homeRevision) {
          if (outcome === "failure") throw new Error("database unavailable");
          harness.computer.updatedAt = new Date(harness.computer.updatedAt.getTime() + 1);
        }
        return updateMany(args);
      });

      const sleep = sleepComputerIfIdle(harness.deps, harness.computer.id);
      if (outcome === "failure") await expect(sleep).rejects.toThrow("database unavailable");
      else await sleep;

      expect(harness.sandbox.stop).not.toHaveBeenCalled();
      expect(harness.computer.homeRevision).toBe("rev-before");
      expect(harness.computer.state).toBe(outcome === "failure" ? "running" : "suspending");
      expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    },
  );

  it.each(["checkpoint failure", "stop failure", "stop success"])(
    "preserves a newer lifecycle owner after %s",
    async (stage) => {
      const harness = idleHarness();
      const invalidate = () => {
        harness.computer.updatedAt = new Date(harness.computer.updatedAt.getTime() + 1);
      };
      if (stage === "checkpoint failure") {
        harness.home.commit.mockImplementationOnce(async () => {
          invalidate();
          throw new Error("checkpoint interrupted");
        });
      } else {
        harness.sandbox.stop.mockImplementationOnce(async () => {
          invalidate();
          if (stage === "stop failure") throw new Error("stop interrupted");
        });
      }

      await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow();

      expect(harness.computer.state).toBe("suspending");
      expect(harness.events.append).not.toHaveBeenCalled();
    },
  );
});

describe("maximum active lifetime", () => {
  const now = new Date("2026-01-01T12:00:00.000Z").getTime();
  const longAgo = new Date(now - DEFAULT_COMPUTER_MAX_ACTIVE_MS - 1);
  const recently = new Date(now - 60_000);

  beforeEach(() => {
    vi.stubEnv("SANDBOX_IDLE_MS", undefined);
    vi.stubEnv("COMPUTER_MAX_ACTIVE_MS", undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    [undefined, DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["0", 0],
    ["garbage", DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["", DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["-1", DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["Infinity", DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["NaN", DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["59999", DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["60000", 60_000],
    ["1800000", 30 * 60_000],
  ])("parses COMPUTER_MAX_ACTIVE_MS=%j", (value, expected) => {
    vi.stubEnv("COMPUTER_MAX_ACTIVE_MS", value);
    expect(computerMaxActiveMs()).toBe(expected);
  });

  it.each([undefined, false])("does not cap a provider reporting %s", async (billing) => {
    const harness = idleHarness({
      billsWhileRunning: billing,
      runningSince: longAgo,
      backgroundWorkProbeCode: 0,
    });
    await touchRunningComputer(harness.deps, harness.computer);
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.sandbox.keepAlive).toHaveBeenCalledTimes(2);
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledTimes(2);
    for (const [job] of harness.jobs.enqueue.mock.calls) {
      expect(job.availableAt).toEqual(new Date(now + DEFAULT_SANDBOX_IDLE_MS));
    }
  });

  it("disables the cap on a billing provider with 0", async () => {
    vi.stubEnv("COMPUTER_MAX_ACTIVE_MS", "0");
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: longAgo,
      backgroundWorkProbeCode: 0,
    });
    await touchRunningComputer(harness.deps, harness.computer);
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.sandbox.keepAlive).toHaveBeenCalledTimes(2);
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    for (const [job] of harness.jobs.enqueue.mock.calls) {
      expect(job.availableAt).toEqual(new Date(now + DEFAULT_SANDBOX_IDLE_MS));
    }
  });

  it("honours a custom thirty-minute cap", async () => {
    vi.stubEnv("COMPUTER_MAX_ACTIVE_MS", "1800000");
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: new Date(now - 30 * 60_000),
      backgroundWorkProbeCode: 0,
    });
    await touchRunningComputer(harness.deps, harness.computer);
    expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(now) }),
    );
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("is two hours", () => {
    expect(DEFAULT_COMPUTER_MAX_ACTIVE_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("keeps a viewed computer alive within the limit", async () => {
    const harness = idleHarness({ billsWhileRunning: true, runningSince: recently });

    await touchRunningComputer(harness.deps, harness.computer);

    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(now + DEFAULT_SANDBOX_IDLE_MS) }),
    );
  });

  it("stops extending a viewed computer past the limit and checks it now", async () => {
    const harness = idleHarness({ billsWhileRunning: true, runningSince: longAgo });

    await touchRunningComputer(harness.deps, harness.computer);

    expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "computer.sleep", availableAt: new Date(now) }),
    );
  });

  it("suspends past the limit even while background work keeps it busy", async () => {
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: longAgo,
      backgroundWorkProbeCode: 0,
    });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.computer.state).toBe("suspended");
    expect(harness.computer.runningSince).toBeNull();
  });

  it("still waits for background work within the limit", async () => {
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: recently,
      backgroundWorkProbeCode: 0,
    });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
  });

  it("suspends past the limit under a run that is only waiting", async () => {
    const harness = idleHarness({ billsWhileRunning: true, runningSince: longAgo });
    harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
      where.leaseExpiresAt ? null : { id: "waiting-for-approval" },
    );

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("leaves a computer the user is controlling to its control lease", async () => {
    const control = {
      controlHolder: "user",
      controlLeaseId: "lease",
      controlLeaseExpiresAt: new Date(now + 60_000),
    };
    const harness = idleHarness({ billsWhileRunning: true, runningSince: longAgo });
    Object.assign(harness.computer, control);
    harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
      where.status.in.includes("waiting_takeover") ? { id: "waiting-for-user" } : null,
    );

    for (const elapsed of [0, 60_000, DEFAULT_COMPUTER_MAX_ACTIVE_MS + 60_000]) {
      vi.setSystemTime(now + elapsed);
      Object.assign(harness.computer, {
        controlLeaseExpiresAt: new Date(now + elapsed + 60_000),
      });
      await touchRunningComputer(harness.deps, harness.computer);
      await sleepComputerIfIdle(harness.deps, harness.computer.id);
      expect(harness.jobs.enqueue).toHaveBeenLastCalledWith(
        expect.objectContaining({
          availableAt: new Date(now + elapsed + DEFAULT_SANDBOX_IDLE_MS),
        }),
      );
    }

    expect(harness.sandbox.keepAlive).toHaveBeenCalledTimes(3);
    expect(harness.jobs.enqueue).toHaveBeenCalledTimes(6);
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
  });

  it("does not pull the computer out from under a run that is executing", async () => {
    const harness = idleHarness({ billsWhileRunning: true, runningSince: longAgo });
    harness.prisma.run.findFirst.mockResolvedValue({ id: "executing" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["leased", "running"] },
          leaseExpiresAt: { gt: new Date(now) },
        }),
      }),
    );
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(now + DEFAULT_SANDBOX_IDLE_MS) }),
    );
  });
});

describe("background work launch and probe", () => {
  const children: ReturnType<typeof spawn>[] = [];
  const markers = new Set<string>();

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
    }
    for (const marker of markers) {
      rmSync(marker, { force: true, recursive: true });
    }
    markers.clear();
  });

  it.skipIf(process.platform === "win32")(
    "detects active work only when launch and probe share the same marker id",
    async () => {
      const databaseId = "computer-db-id";
      const providerRef = "provider-ref";
      const launchId = "active";
      markers.add(`/tmp/rakazo-background-${databaseId}-run-1-${launchId}`);

      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          databaseId,
          "run-1",
          launchId,
          "exec sleep 30",
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      await expect.poll(() => probeBackgroundWork(databaseId)).toBe(0);
      // ComputerRef.id is providerRef today; probing that path must not see the DB-id marker.
      expect(await probeBackgroundWork(providerRef)).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans a completed marker without blocking a later launch",
    async () => {
      const markerId = "computer-relaunch-id";
      const completedMarker = `/tmp/rakazo-background-${markerId}-run-1-completed`;
      const activeMarker = `/tmp/rakazo-background-${markerId}-run-1-active`;
      markers.add(completedMarker);
      markers.add(activeMarker);
      const completed = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "completed",
          "true",
        ],
        { stdio: "ignore" },
      );
      children.push(completed);

      expect(await processExit(completed)).toBe(0);
      expect(await probeBackgroundWork(markerId)).toBe(1);
      expect(existsSync(completedMarker)).toBe(false);

      const active = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "active",
          "exec sleep 30",
        ],
        { stdio: "ignore" },
      );
      children.push(active);
      await expect.poll(() => probeBackgroundWork(markerId)).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not run the command when its marker cannot be opened",
    async () => {
      const markerId = "computer-marker-error";
      const marker = `/tmp/rakazo-background-${markerId}-run-1-collision`;
      const commandRan = `/tmp/rakazo-background-command-ran-${markerId}`;
      markers.add(marker);
      markers.add(commandRan);
      mkdirSync(marker);
      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "collision",
          `touch ${commandRan}`,
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      expect(await processExit(launched)).not.toBe(0);
      expect(existsSync(commandRan)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not follow a pre-existing marker symlink",
    async () => {
      const markerId = "computer-marker-symlink";
      const marker = `/tmp/rakazo-background-${markerId}-run-1-collision`;
      const commandRan = `/tmp/rakazo-background-command-ran-${markerId}`;
      markers.add(marker);
      markers.add(commandRan);
      symlinkSync(commandRan, marker);
      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "collision",
          `touch ${commandRan}`,
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      expect(await processExit(launched)).not.toBe(0);
      expect(existsSync(commandRan)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cancel tears down background shell work for that run",
    async () => {
      const computerId = "computer-cancel-id";
      const runId = "run-cancel-1";
      const launchId = "active";
      const marker = `/tmp/rakazo-background-${computerId}-${runId}-${launchId}`;
      markers.add(marker);

      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          computerId,
          runId,
          launchId,
          "exec sleep 30",
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      await expect.poll(() => probeBackgroundWork(computerId)).toBe(0);

      const launchedDone = processExit(launched);
      const cancel = spawn(
        "bash",
        ["-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, runId],
        { stdio: "ignore" },
      );
      children.push(cancel);
      expect(await processExit(cancel)).toBe(0);
      await launchedDone;
      expect(await probeBackgroundWork(computerId)).toBe(1);
    },
  );
});

describe("CANCEL_PRIMARY_BROWSER_WORK", () => {
  it("keeps shell parameter expansions literal", () => {
    expect(CANCEL_COMPUTER_RUN_WORK).toContain(`pid="\${fd#/proc/}"; pid="\${pid%%/*}"`);
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain(`kill -TERM "\${pid#/proc/}"`);
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain(`kill -KILL "\${pid#/proc/}"`);
  });

  it("targets the primary profile and matches browser argv0 only", () => {
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain(".browser-profiles/chromium");
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain("chromium-screen-");
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain('argv0=""; IFS= read -r -d "" argv0');
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain("*/chromium|*/chromium-*|chromium|chromium-*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain("*/firefox|*/firefox-*|firefox|firefox-*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).not.toContain("*[c]hromium*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).not.toContain("*[f]irefox*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).not.toContain("*[g]oogle-chrome*");
  });
});

describe("e2b create options", () => {
  it("pauses on timeout instead of killing the sandbox", () => {
    const opts = e2bCreateOptions("bot-1", "e2b_test");
    expect(opts.lifecycle).toEqual({ onTimeout: "pause", autoResume: false });
    expect(opts.timeoutMs).toBe(sandboxIdleMs());
    expect(opts.metadata.botId).toBe("bot-1");
  });
});

function idleHarness(
  options: {
    backgroundWorkProbeCode?: number;
    backgroundWorkProbeCodes?: number[];
    backgroundWorkProbeFailed?: boolean;
    exportError?: Error;
    probeError?: Error;
    providerBackgroundWorkStatus?: "active" | "idle" | "unknown";
    runningSince?: Date | null;
    billsWhileRunning?: boolean;
  } = {},
) {
  const backgroundWorkProbeCodes = [...(options.backgroundWorkProbeCodes ?? [])];
  const computer = {
    id: "computer-id",
    homeKey: "team-workspace",
    homeRevision: "rev-before",
    providerRef: "computer",
    kind: "e2b",
    state: "running",
    spaceId: "workspace",
    userId: "user",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    executionBotId: null,
    runningSince: options.runningSince ?? null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const prisma = {
    computer: {
      findUnique: vi.fn(async () => ({ ...computer })),
      updateMany: vi.fn(async (args) => {
        if (args.where.updatedAt && args.where.updatedAt.getTime() !== computer.updatedAt.getTime())
          return { count: 0 };
        if (args.data.updatedAt) computer.updatedAt = args.data.updatedAt;
        if (args.data.state) computer.state = args.data.state;
        if (args.data.homeRevision) computer.homeRevision = args.data.homeRevision;
        if ("providerRef" in args.data)
          Object.assign(computer, { providerRef: args.data.providerRef });
        return { count: 1 };
      }),
      update: vi.fn(async (args) => {
        if (args.where.updatedAt && args.where.updatedAt.getTime() !== computer.updatedAt.getTime())
          throw new Error("stale computer lifecycle");
        Object.assign(computer, args.data);
        return computer;
      }),
    },
    run: { findFirst: vi.fn().mockResolvedValue(null) },
    agentHome: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    bot: {
      findMany: vi.fn().mockResolvedValue([{ id: "bot", thread: { id: "thread" } }]),
    },
  };
  const sandbox = {
    billsWhileRunning:
      options.billsWhileRunning === undefined ? undefined : vi.fn(() => options.billsWhileRunning),
    execute: vi.fn(async function* () {
      if (options.probeError) throw options.probeError;
      const code = backgroundWorkProbeCodes.shift() ?? options.backgroundWorkProbeCode ?? 1;
      if (code === 1 && !options.backgroundWorkProbeFailed) {
        yield { type: "stdout", data: "rakazo-background-idle\n" } as const;
      }
      yield { type: "exit", code } as const;
    }),
    keepAlive: vi.fn().mockResolvedValue(undefined),
    exportWorkspace: vi.fn(async function* () {
      if (options.exportError) throw options.exportError;
      yield { path: "notes/result.txt", content: new TextEncoder().encode("durable") };
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    ...(options.providerBackgroundWorkStatus
      ? {
          inspectBackgroundWork: vi.fn().mockResolvedValue(options.providerBackgroundWorkStatus),
        }
      : {}),
  };
  const home = {
    commit: vi.fn().mockResolvedValue("rev-checkpoint"),
  };
  const jobs = {
    enqueue: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const events = { append: vi.fn().mockResolvedValue({}) };
  return {
    computer,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      sandbox: sandbox as unknown as SandboxProvider,
      home: home as unknown as AgentHomeStore,
      jobs: jobs as unknown as JobPublisher,
      events: events as unknown as ThreadEvents,
    },
  };
}

function probeBackgroundWork(markerId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      ["-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", markerId],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function processExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
