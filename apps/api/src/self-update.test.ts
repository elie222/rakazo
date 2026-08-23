import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import {
  type CommandResult,
  type CommandRunner,
  createSelfUpdateService,
  resolveRepoRoot,
  SelfUpdateRefused,
} from "./self-update.js";
import { type UpdaterClient, UpdaterRefused, UpdaterUnreachable } from "./updater-client.js";

const REPO_ROOT = "/srv/rakazo";
const OFFICIAL_REPO = "https://github.com/elie222/rakazo";
const HEAD = "1111111111111111111111111111111111111111";
const TARGET = "2222222222222222222222222222222222222222";

type Row = {
  updateRepoUrl: string | null;
  updateBranch: string | null;
  updateLastRun: string | null;
  updateLeaseId: string | null;
  updateLeaseExpiresAt: Date | null;
};

function fakePrisma(initial: Partial<Row> = {}) {
  const row: Row = {
    updateRepoUrl: null,
    updateBranch: null,
    updateLastRun: null,
    updateLeaseId: null,
    updateLeaseExpiresAt: null,
    ...initial,
  };
  return {
    row,
    prisma: {
      deploymentSettings: {
        findUnique: async () => row,
        upsert: async ({ update }: { update: Partial<Row> }) => {
          Object.assign(row, update);
          return row;
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: {
            updateLeaseId?: string;
            OR?: Array<{
              updateLeaseExpiresAt: null | { lte: Date };
            }>;
          };
          data: Partial<Row>;
        }) => {
          if (where.updateLeaseId !== undefined && row.updateLeaseId !== where.updateLeaseId) {
            return { count: 0 };
          }
          if (where.OR) {
            const available = where.OR.some((condition) => {
              if (condition.updateLeaseExpiresAt === null) return row.updateLeaseExpiresAt === null;
              return (
                row.updateLeaseExpiresAt !== null &&
                row.updateLeaseExpiresAt <= condition.updateLeaseExpiresAt.lte
              );
            });
            if (!available) return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient,
  };
}

function recorder(overrides: Record<string, CommandResult> = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  let currentHead = HEAD;
  let currentRemote = OFFICIAL_REPO;
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    const key = [command, ...args].join(" ");
    const override = Object.entries(overrides).find(([prefix]) => key.startsWith(prefix));
    if (override) return override[1];
    if (key === "git rev-parse HEAD") return ok(currentHead);
    if (key.startsWith("git rev-parse --abbrev-ref")) return ok("main");
    if (key.startsWith("git remote get-url")) return ok(currentRemote);
    if (key.startsWith("git remote set-url")) {
      currentRemote = args.at(-1) ?? currentRemote;
      return ok("");
    }
    if (key.startsWith("git rev-parse --verify FETCH_HEAD")) return ok(TARGET);
    if (key.startsWith("git merge --ff-only")) {
      currentHead = args.at(-1) ?? currentHead;
      return ok("");
    }
    if (key.startsWith("git rev-list")) return ok("3");
    if (key.startsWith("git status")) return ok("");
    return ok("");
  };
  return { calls, runner };
}

function ok(output: string): CommandResult {
  return { ok: true, exitCode: 0, output };
}

function fail(output: string, exitCode = 1): CommandResult {
  return { ok: false, exitCode, output };
}

function service(
  options: {
    runner?: CommandRunner;
    prisma?: PrismaClient;
    env?: NodeJS.ProcessEnv;
    repoRoot?: string | null;
    exit?: () => void;
    updater?: UpdaterClient | null;
  } = {},
) {
  return createSelfUpdateService({
    prisma: options.prisma ?? fakePrisma().prisma,
    version: "0.1.0",
    revision: HEAD,
    repoRoot: options.repoRoot === undefined ? REPO_ROOT : options.repoRoot,
    unsupportedReason: options.repoRoot === null ? "Not a git checkout." : null,
    updater: options.updater ?? null,
    env: options.env ?? {},
    run: options.runner ?? recorder().runner,
    exit: options.exit ?? (() => undefined),
  });
}

const sidecarCheckout = {
  present: true,
  commit: HEAD,
  branch: "main",
  remoteUrl: "https://github.com/elie222/rakazo.git",
  dirty: false,
  dirtyPaths: [] as string[],
};

function fakeUpdater(overrides: Partial<UpdaterClient> = {}): UpdaterClient {
  return {
    state: async () => ({
      deployDir: "/srv/rakazo",
      composeFile: "/srv/rakazo/infra/compose/docker-compose.prod.yml",
      image: "ghcr.io/elie222/rakazo/app",
      imageRef: "ghcr.io/elie222/rakazo/app:v1.0.0",
      running: false,
      currentTag: "v1.0.0",
      previousTag: "v0.9.0",
      checkout: sidecarCheckout,
    }),
    plan: async () => ({
      strategy: "pull" as const,
      reason: "Official releases are published as images.",
      currentTag: "v1.0.0",
      previousTag: "v0.9.0",
      targetTag: "v1.1.0",
      targetCommit: null,
      upToDate: false,
      checkout: sidecarCheckout,
    }),
    apply: async () => sidecarRun(),
    rollback: async () => sidecarRun({ toTag: "v0.9.0" }),
    ...overrides,
  };
}

function sidecarRun(overrides: Record<string, unknown> = {}) {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    ok: true,
    fromCommit: null,
    toCommit: null,
    fromTag: "v1.0.0",
    toTag: "v1.1.0",
    strategy: "pull" as const,
    repoUrl: "https://github.com/elie222/rakazo",
    branch: "main",
    restart: "recreated" as const,
    restartAdvice: "The updater recreated the containers.",
    error: null,
    steps: [],
    ...overrides,
  };
}

describe("resolveRepoRoot", () => {
  it("finds the workspace root of this repository and refuses a bare directory", async () => {
    expect(await resolveRepoRoot(import.meta.dirname)).not.toBeNull();
    expect(await resolveRepoRoot("/")).toBeNull();
  });
});

describe("status", () => {
  it("defaults to the official repository on main", async () => {
    const status = await service().status();
    expect(status.supported).toBe(true);
    expect(status.source).toEqual({
      repoUrl: "https://github.com/elie222/rakazo",
      branch: "main",
      official: true,
    });
    expect(status.commit).toBe(HEAD);
    expect(status.restartSupervisor).toBe("none");
    expect(status.restartAdvice).toContain("RAKAZO_UPDATE_RESTART_SUPERVISOR");
  });

  it("reports a fork as unofficial and reads back what was stored", async () => {
    const { prisma, row } = fakePrisma();
    const status = await service({ prisma }).setSource({
      repoUrl: "git@github.com:me/rakazo.git",
      branch: "release/1.2",
    });
    expect(row.updateRepoUrl).toBe("git@github.com:me/rakazo.git");
    expect(row.updateBranch).toBe("release/1.2");
    expect(status.source).toEqual({
      repoUrl: "git@github.com:me/rakazo.git",
      branch: "release/1.2",
      official: false,
    });
  });

  it("falls back to the official source when a stored value is no longer acceptable", async () => {
    const { prisma } = fakePrisma({ updateRepoUrl: "http://evil.example/x/y", updateBranch: "-f" });
    const status = await service({ prisma }).status();
    expect(status.source).toEqual({
      repoUrl: "https://github.com/elie222/rakazo",
      branch: "main",
      official: true,
    });
  });

  it("says plainly when the deployment is not a checkout", async () => {
    const status = await service({ repoRoot: null }).status();
    expect(status.supported).toBe(false);
    expect(status.unsupportedReason).toBe("Not a git checkout.");
    expect(status.commit).toBeNull();
  });

  it("names the supervisor that will bring the process back", async () => {
    const status = await service({ env: { INVOCATION_ID: "abc" } }).status();
    expect(status.restartSupervisor).toBe("systemd");
  });
});

describe("setSource", () => {
  it("refuses a URL or branch that is not a plain git remote", async () => {
    const subject = service();
    await expect(
      subject.setSource({ repoUrl: "http://x/y/z", branch: "main" }),
    ).rejects.toBeInstanceOf(SelfUpdateRefused);
    await expect(
      subject.setSource({ repoUrl: "https://github.com/me/rakazo", branch: "a b" }),
    ).rejects.toBeInstanceOf(SelfUpdateRefused);
  });
});

describe("check", () => {
  it("reports an available update with how far behind the checkout is", async () => {
    expect(await service().check()).toEqual({
      status: "available",
      reason: null,
      changed: [],
      commit: HEAD,
      targetCommit: TARGET,
      behindBy: 3,
    });
  });

  it("reports up to date when the remote points at the same commit", async () => {
    const { runner } = recorder({ "git rev-parse --verify FETCH_HEAD": ok(HEAD) });
    expect(await service({ runner }).check()).toMatchObject({
      status: "up-to-date",
      commit: HEAD,
    });
  });

  it("refuses a dirty tree and lists what is in the way", async () => {
    const { runner } = recorder({ "git status": ok(" M apps/api/src/app.ts\n") });
    const result = await service({ runner }).check();
    expect(result.status).toBe("dirty");
    expect(result.changed).toEqual(["apps/api/src/app.ts"]);
    expect(result.reason).toContain("uncommitted changes");
  });

  it("surfaces a failed fetch instead of guessing", async () => {
    const { runner } = recorder({ "git fetch": fail("could not read Username") });
    const result = await service({ runner }).check();
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("could not read Username");
  });

  it("fetches a newly selected repository directly instead of checking the stale origin", async () => {
    const { prisma } = fakePrisma({ updateRepoUrl: "https://github.com/me/rakazo.git" });
    const recorded = recorder();
    await service({ prisma, runner: recorded.runner }).check();
    expect(recorded.calls.find((call) => call.args[0] === "fetch")?.args).toEqual([
      "fetch",
      "--no-tags",
      "--prune",
      "https://github.com/me/rakazo.git",
      "main",
    ]);
  });

  it("uses the selected transport even when origin has the same repository identity", async () => {
    const recorded = recorder({
      "git remote get-url": ok("git@github.com:elie222/rakazo.git"),
    });
    await service({ runner: recorded.runner }).check();
    expect(recorded.calls.find((call) => call.args[0] === "fetch")?.args).toEqual([
      "fetch",
      "--no-tags",
      "--prune",
      OFFICIAL_REPO,
      "main",
    ]);
  });
});

describe("apply", () => {
  it("runs the whole sequence and stops short of exiting without a supervisor", async () => {
    const { prisma, row } = fakePrisma();
    let exited = false;
    const { calls, runner } = recorder();
    const record = await service({ prisma, runner, exit: () => (exited = true) }).apply();

    expect(record.ok).toBe(true);
    expect(record.steps.map((step) => step.id)).toEqual([
      "fetch",
      "merge",
      "install",
      "generate",
      "build",
      "migrate",
    ]);
    expect(record.restart).toBe("manual");
    expect(exited).toBe(false);
    expect(JSON.parse(row.updateLastRun ?? "null")).toMatchObject({ ok: true });
    expect(calls.every((call) => call.command === "git" || call.command === "pnpm")).toBe(true);
    expect(calls.find((call) => call.args[0] === "merge")?.args).toEqual([
      "merge",
      "--ff-only",
      TARGET,
    ]);
    expect(
      calls.find((call) => call.command === "pnpm" && call.args[0] === "install")?.args,
    ).toEqual(["install", "--frozen-lockfile"]);
  });

  it("exits for the supervisor to restart once a supervisor is known", async () => {
    let exited = false;
    const record = await service({
      env: { RAKAZO_UPDATE_RESTART_SUPERVISOR: "docker" },
      exit: () => (exited = true),
    }).apply();
    expect(record.restart).toBe("supervised");
    expect(record.restartAdvice).toContain("docker");
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(exited).toBe(true);
  });

  it("re-points the remote only when the chosen repository differs", async () => {
    const plain = recorder();
    await service({ runner: plain.runner }).apply();
    expect(plain.calls.some((call) => call.args.includes("set-url"))).toBe(false);

    const { prisma } = fakePrisma({ updateRepoUrl: "https://github.com/me/rakazo.git" });
    const forked = recorder();
    const record = await service({ prisma, runner: forked.runner }).apply();
    expect(record.steps[0]?.id).toBe("remote");
    expect(forked.calls.find((call) => call.args.includes("set-url"))?.args).toEqual([
      "remote",
      "set-url",
      "origin",
      "https://github.com/me/rakazo.git",
    ]);
  });

  it("stops at the first failing step and never restarts a broken deployment", async () => {
    let exited = false;
    const { calls, runner } = recorder({
      "pnpm --filter @rakazo/db run migrate": fail("relation exists"),
    });
    const record = await service({
      runner,
      env: { RAKAZO_UPDATE_RESTART_SUPERVISOR: "docker" },
      exit: () => (exited = true),
    }).apply();

    expect(record.ok).toBe(false);
    expect(record.error).toContain("Apply database migrations");
    expect(record.steps.at(-1)).toMatchObject({
      id: "migrate",
      ok: false,
      output: "relation exists",
    });
    expect(record.restart).toBe("manual");
    expect(record.restartAdvice).toContain("Nothing was restarted");
    expect(exited).toBe(false);
    expect(calls.some((call) => call.args.includes("--hard"))).toBe(false);
  });

  it("does nothing when the checkout is already on the target commit", async () => {
    const { runner, calls } = recorder({ "git rev-parse --verify FETCH_HEAD": ok(HEAD) });
    const record = await service({ runner }).apply();
    expect(record).toMatchObject({ ok: true, restart: "not-required", steps: [] });
    expect(calls.some((call) => call.command === "pnpm")).toBe(false);
  });

  it("repoints origin when a newly selected repository already has the running commit", async () => {
    const selected = OFFICIAL_REPO;
    const { prisma } = fakePrisma({ updateRepoUrl: selected });
    const { runner, calls } = recorder({
      "git remote get-url": ok("git@github.com:elie222/rakazo.git"),
      "git rev-parse --verify FETCH_HEAD": ok(HEAD),
    });
    const record = await service({ prisma, runner }).apply();
    expect(record).toMatchObject({
      ok: true,
      restart: "not-required",
      steps: [{ id: "remote", ok: true }],
    });
    expect(calls.find((call) => call.args[1] === "set-url")?.args).toEqual([
      "remote",
      "set-url",
      "origin",
      selected,
    ]);
    expect(calls.some((call) => call.command === "pnpm")).toBe(false);
  });

  it("reports a failed equal-commit repoint without running code or database changes", async () => {
    const { prisma } = fakePrisma({ updateRepoUrl: OFFICIAL_REPO });
    const { runner, calls } = recorder({
      "git remote get-url": ok("git@github.com:elie222/rakazo.git"),
      "git rev-parse --verify FETCH_HEAD": ok(HEAD),
      "git remote set-url": { ok: false, exitCode: 2, output: "fake remote failure" },
    });
    const record = await service({ prisma, runner }).apply();
    expect(record).toMatchObject({
      ok: false,
      restart: "not-required",
      error: "Point origin at the selected repository failed.",
    });
    expect(record.restartAdvice).toContain("No code or database changes were made");
    expect(calls.some((call) => call.command === "pnpm")).toBe(false);
  });

  it("refuses to touch a dirty tree", async () => {
    const { runner } = recorder({ "git status": ok(" M packages/db/prisma/schema.prisma\n") });
    await expect(service({ runner }).apply()).rejects.toBeInstanceOf(SelfUpdateRefused);
  });

  it("refuses when the deployment is not a checkout", async () => {
    await expect(service({ repoRoot: null }).apply()).rejects.toBeInstanceOf(SelfUpdateRefused);
  });

  it("uses a database lease so two requests cannot update the checkout concurrently", async () => {
    const { prisma, row } = fakePrisma();
    const recorded = recorder();
    let releaseFetch: () => void = () => undefined;
    let markFetchStarted: () => void = () => undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let held = false;
    const runner: CommandRunner = async (command, args, options) => {
      if (!held && command === "git" && args[0] === "fetch") {
        held = true;
        markFetchStarted();
        await fetchGate;
      }
      return recorded.runner(command, args, options);
    };
    const subject = service({ prisma, runner });
    const first = subject.apply();
    await fetchStarted;
    await expect(subject.apply()).rejects.toThrow(/already running/);
    await expect(subject.check()).rejects.toThrow(/already running/);
    await expect(
      subject.setSource({ repoUrl: "https://github.com/me/rakazo", branch: "main" }),
    ).rejects.toThrow(/running update/);
    releaseFetch();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(row.updateLeaseId).toBeNull();
  });

  it("persists an unfinished run before every mutation so process death is visible", async () => {
    const { prisma, row } = fakePrisma();
    const recorded = recorder();
    const runner: CommandRunner = async (command, args, options) => {
      if (command === "pnpm" && args.includes("build")) throw new Error("simulated process death");
      return recorded.runner(command, args, options);
    };
    await expect(service({ prisma, runner }).apply()).rejects.toThrow(/simulated process death/);
    expect(JSON.parse(row.updateLastRun ?? "null")).toMatchObject({
      ok: false,
      finishedAt: null,
      steps: expect.arrayContaining([expect.objectContaining({ id: "generate", ok: true })]),
    });
    expect(row.updateLeaseId).toBeNull();
  });
});

describe("sidecar mode", () => {
  it("prefers the sidecar over a checkout, and stops talking about supervisors", async () => {
    const status = await service({ updater: fakeUpdater() }).status();
    expect(status.mode).toBe("sidecar");
    expect(status.supported).toBe(true);
    expect(status.strategy).toBe("pull");
    expect(status.restartAdvice).toMatch(/no process supervisor is required/);
  });

  it("reports the deployed image tag and whether a rollback target exists", async () => {
    const status = await service({ updater: fakeUpdater() }).status();
    expect(status).toMatchObject({
      image: "ghcr.io/elie222/rakazo/app",
      imageTag: "v1.0.0",
      previousImageTag: "v0.9.0",
      canRollback: true,
    });
  });

  it("has no rollback target before the first update", async () => {
    const updater = fakeUpdater({
      state: async () => ({
        ...(await fakeUpdater().state()),
        currentTag: "latest",
        previousTag: null,
      }),
    });
    expect((await service({ updater }).status()).canRollback).toBe(false);
  });

  it("says the sidecar is not answering rather than silently using the checkout engine", async () => {
    const updater = fakeUpdater({
      state: async () => {
        throw new UpdaterUnreachable("connect ECONNREFUSED");
      },
    });
    const status = await service({ updater }).status();
    expect(status.mode).toBe("sidecar");
    expect(status.supported).toBe(false);
    expect(status.unsupportedReason).toMatch(/not answering/);
  });

  it("turns a fork's build strategy into the warning the UI shows", async () => {
    const { prisma } = fakePrisma({
      updateRepoUrl: "https://github.com/someone/rakazo",
      updateBranch: "main",
    });
    const status = await service({ prisma, updater: fakeUpdater() }).status();
    expect(status.strategy).toBe("build");
    expect(status.strategyNote).toMatch(/minutes/);
  });

  it("reads availability from the sidecar's plan", async () => {
    const check = await service({ updater: fakeUpdater() }).check();
    expect(check.status).toBe("available");
    expect(check.reason).toContain("v1.1.0");
  });

  it("reports up to date when the sidecar says the target tag is already deployed", async () => {
    const updater = fakeUpdater({
      plan: async () => ({
        ...(await fakeUpdater().plan({ repoUrl: "", branch: "" })),
        upToDate: true,
      }),
    });
    expect((await service({ updater }).check()).status).toBe("up-to-date");
  });

  it("surfaces a dirty fork checkout as dirty rather than as available", async () => {
    const updater = fakeUpdater({
      plan: async () => ({
        ...(await fakeUpdater().plan({ repoUrl: "", branch: "" })),
        strategy: "build" as const,
        targetTag: null,
        checkout: { ...sidecarCheckout, dirty: true, dirtyPaths: ["apps/api/src/app.ts"] },
      }),
    });
    const check = await service({ updater }).check();
    expect(check.status).toBe("dirty");
    expect(check.changed).toEqual(["apps/api/src/app.ts"]);
  });

  it("turns a sidecar refusal into a check the UI can render, not a crash", async () => {
    const updater = fakeUpdater({
      plan: async () => {
        throw new UpdaterRefused("that fork has no published release tags");
      },
    });
    const check = await service({ updater }).check();
    expect(check).toMatchObject({ status: "unavailable", reason: /no published release tags/ });
  });

  it("records the sidecar's run so the overlay can show it after the recreate", async () => {
    const { prisma, row } = fakePrisma();
    const record = await service({ prisma, updater: fakeUpdater() }).apply();
    expect(record).toMatchObject({ ok: true, restart: "recreated", toTag: "v1.1.0" });
    expect(JSON.parse(row.updateLastRun ?? "{}")).toMatchObject({ toTag: "v1.1.0" });
  });

  it("passes the configured source through to the sidecar", async () => {
    const seen: Array<{ repoUrl: string; branch: string }> = [];
    const updater = fakeUpdater({
      apply: async (request) => {
        seen.push(request);
        return sidecarRun();
      },
    });
    const { prisma } = fakePrisma({
      updateRepoUrl: "git@github.com:me/rakazo.git",
      updateBranch: "release/1.2",
    });
    await service({ prisma, updater }).apply();
    expect(seen).toEqual([
      expect.objectContaining({ repoUrl: "git@github.com:me/rakazo.git", branch: "release/1.2" }),
    ]);
  });

  it("refuses a rollback on a checkout deployment and explains the manual route", async () => {
    await expect(service().rollback()).rejects.toBeInstanceOf(SelfUpdateRefused);
    await expect(service().rollback()).rejects.toThrow(/git checkout/);
  });

  it("rolls back through the sidecar and records the run", async () => {
    const { prisma, row } = fakePrisma();
    const record = await service({ prisma, updater: fakeUpdater() }).rollback();
    expect(record.toTag).toBe("v0.9.0");
    expect(row.updateLastRun).toContain("v0.9.0");
  });

  it("reports the sidecar's refusal verbatim when it will not roll back", async () => {
    const updater = fakeUpdater({
      rollback: async () => {
        throw new UpdaterRefused("No previous image tag was recorded.");
      },
    });
    await expect(service({ updater }).rollback()).rejects.toThrow(/No previous image tag/);
  });
});
