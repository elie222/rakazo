import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { ByokTier } from "@rakazo/contracts";
import { SANDBOX_HOURLY_COST_MICROS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { planComputerSize } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  sandboxAllowance,
  sandboxAllowanceUsedUp,
  sandboxHourlyCostMicros,
  sandboxHoursLeft,
} from "./sandbox-allowance.js";

function allowanceDeps(input: {
  billing: boolean;
  mode: string | null;
  creditAmountCents?: number | null;
  subscription?: {
    status: string;
    cancelAtPeriodEnd?: boolean;
    currentPeriodStartsAt?: Date | null;
    byokInterval?: "month" | "year";
    byokTier?: ByokTier | null;
    byokPriceCents?: number | null;
  };
  hours?: Array<{ kind: string; hours: number }>;
  sandbox?: Partial<SandboxProvider>;
}) {
  const prisma = {
    deploymentSettings: {
      findUnique: vi.fn().mockResolvedValue({ modelCreditsEnabled: input.billing }),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        modelCredits: input.mode ? { mode: input.mode } : null,
        billing:
          input.creditAmountCents === undefined && !input.subscription
            ? null
            : {
                creditAmountCents: input.creditAmountCents ?? null,
                status: input.subscription?.status ?? null,
                cancelAtPeriodEnd: input.subscription?.cancelAtPeriodEnd ?? false,
                currentPeriodStartsAt: input.subscription?.currentPeriodStartsAt ?? null,
                byokInterval: input.subscription?.byokInterval ?? null,
                byokTier: input.subscription?.byokTier ?? null,
                byokPriceCents: input.subscription?.byokPriceCents ?? null,
              },
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue(input.hours ?? []),
  };
  return {
    prisma,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      sandbox: { billsWhileRunning: () => true, ...input.sandbox } as SandboxProvider,
    },
  };
}

describe("computer allowance", () => {
  it("has no limit without model-credit billing", async () => {
    const { deps, prisma } = allowanceDeps({ billing: false, mode: "byok" });
    expect(await sandboxAllowance(deps, "organization")).toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("gives an own-key organization $5 a period", async () => {
    const { deps } = allowanceDeps({
      billing: true,
      mode: "byok",
      hours: [{ kind: "daytona", hours: 2.5 }],
    });
    expect(await sandboxAllowance(deps, "organization")).toEqual({
      limitMicros: 5_000_000,
      usedMicros: 2.5 * SANDBOX_HOURLY_COST_MICROS,
    });
  });

  it("gives a live own-key subscription its tier's allowance", async () => {
    const limit = async (status: string, byokTier: ByokTier | null) =>
      (
        await sandboxAllowance(
          allowanceDeps({ billing: true, mode: "byok", subscription: { status, byokTier } }).deps,
          "organization",
        )
      )?.limitMicros;
    expect(await limit("active", "pro")).toBe(20_000_000);
    expect(await limit("past_due", "max")).toBe(40_000_000);
    // Rows synced before tiers existed are Standard.
    expect(await limit("active", null)).toBe(5_000_000);
    // A lapsed plan's tier no longer applies.
    expect(await limit("canceled", "max")).toBe(5_000_000);
    // Every tier's trial gets the trial allowance.
    expect(await limit("trialing", "max")).toBe(2_000_000);
  });

  it("gives a monthly credit plan a fifth of its amount", async () => {
    const { deps } = allowanceDeps({ billing: true, mode: "credits", creditAmountCents: 5000 });
    expect((await sandboxAllowance(deps, "organization"))?.limitMicros).toBe(10_000_000);
  });

  it.each<[string | null, string]>([
    ["credits", "a top-up switched its models to credits"],
    [null, "it never chose how to pay for models"],
  ])("keeps a paid own-key subscription's hours when its mode is %s (%s)", async (mode) => {
    const { deps } = allowanceDeps({
      billing: true,
      mode,
      subscription: { status: "active", byokTier: "pro", byokPriceCents: 4900 },
    });
    expect((await sandboxAllowance(deps, "organization"))?.limitMicros).toBe(20_000_000);
  });

  it("gives nothing without a monthly plan", async () => {
    const { deps } = allowanceDeps({ billing: true, mode: "credits", creditAmountCents: null });
    expect((await sandboxAllowance(deps, "organization"))?.limitMicros).toBe(0);
  });

  it("gives a trial $2 and a cancelled trial nothing", async () => {
    const trial = allowanceDeps({
      billing: true,
      mode: "byok",
      subscription: { status: "trialing" },
    });
    expect((await sandboxAllowance(trial.deps, "organization"))?.limitMicros).toBe(2_000_000);
    const cancelled = allowanceDeps({
      billing: true,
      mode: "byok",
      subscription: { status: "trialing", cancelAtPeriodEnd: true },
    });
    expect((await sandboxAllowance(cancelled.deps, "organization"))?.limitMicros).toBe(0);
  });

  it("keeps the full allowance for a paid plan set to cancel", async () => {
    const { deps } = allowanceDeps({
      billing: true,
      mode: "byok",
      subscription: { status: "active", cancelAtPeriodEnd: true },
    });
    expect((await sandboxAllowance(deps, "organization"))?.limitMicros).toBe(5_000_000);
  });

  it("counts from the start of the billing period, up to now", async () => {
    const periodStart = new Date("2026-02-20T14:00:00.000Z");
    const { deps, prisma } = allowanceDeps({
      billing: true,
      mode: "byok",
      subscription: { status: "active", currentPeriodStartsAt: periodStart },
    });
    const now = new Date("2026-03-17T08:30:00.000Z");
    await sandboxAllowance(deps, "organization", now);
    const values = prisma.$queryRaw.mock.calls[0]?.slice(1);
    expect(values).toContainEqual(periodStart);
    expect(values).toContainEqual(now);
  });

  it("renews a yearly plan's allowance monthly, on the day the year began", async () => {
    const periodStart = new Date("2026-01-31T14:00:00.000Z");
    const since = async (now: string) => {
      const { deps, prisma } = allowanceDeps({
        billing: true,
        mode: "byok",
        subscription: {
          status: "active",
          currentPeriodStartsAt: periodStart,
          byokInterval: "year",
        },
      });
      await sandboxAllowance(deps, "organization", new Date(now));
      // The query reads `now`, `now`, then `since`.
      return prisma.$queryRaw.mock.calls[0]?.[3];
    };
    expect(await since("2026-01-31T15:00:00.000Z")).toEqual(periodStart);
    // February is short, so its anniversary is the 28th.
    expect(await since("2026-03-10T00:00:00.000Z")).toEqual(new Date("2026-02-28T14:00:00.000Z"));
    expect(await since("2026-03-31T13:00:00.000Z")).toEqual(new Date("2026-02-28T14:00:00.000Z"));
    expect(await since("2026-03-31T14:00:00.000Z")).toEqual(new Date("2026-03-31T14:00:00.000Z"));
    expect(await since("2026-12-05T00:00:00.000Z")).toEqual(new Date("2026-11-30T14:00:00.000Z"));
  });

  it("counts the calendar month without a live subscription", async () => {
    const { deps, prisma } = allowanceDeps({
      billing: true,
      mode: "byok",
      subscription: {
        status: "canceled",
        currentPeriodStartsAt: new Date("2026-02-20T14:00:00.000Z"),
      },
    });
    const now = new Date("2026-03-17T08:30:00.000Z");
    await sandboxAllowance(deps, "organization", now);
    const values = prisma.$queryRaw.mock.calls[0]?.slice(1);
    expect(values).toContainEqual(new Date("2026-03-01T00:00:00.000Z"));
  });

  it("counts only computers that bill while running", async () => {
    const { deps } = allowanceDeps({
      billing: true,
      mode: "byok",
      hours: [
        { kind: "boat", hours: 2 },
        { kind: "docker", hours: 10 },
      ],
      sandbox: {
        billsWhileRunning: (computer) => computer.kind === "boat",
      },
    });
    expect((await sandboxAllowance(deps, "organization"))?.usedMicros).toBe(400_000);
  });
});

describe("computer allowance used up", () => {
  function usedUpDeps(hours: number, organizationId: string | null = "organization") {
    const { deps, prisma } = allowanceDeps({
      billing: true,
      mode: "byok",
      hours: [{ kind: "e2b", hours }],
    });
    Object.assign(prisma, {
      space: {
        findUnique: vi.fn().mockResolvedValue(organizationId ? { organizationId } : null),
      },
    });
    return deps;
  }
  const paid = { spaceId: "space", kind: "e2b" };

  it("stops a billed computer only once the period's allowance is spent", async () => {
    expect(await sandboxAllowanceUsedUp(usedUpDeps(24), paid)).toBe(false);
    expect(await sandboxAllowanceUsedUp(usedUpDeps(25), paid)).toBe(true);
  });

  it("never stops a free computer or one whose space is gone", async () => {
    expect(
      await sandboxAllowanceUsedUp(usedUpDeps(25), { spaceId: "space", kind: "desktop" }),
    ).toBe(false);
    expect(await sandboxAllowanceUsedUp(usedUpDeps(25, null), paid)).toBe(false);
  });
});

describe("computer hourly cost", () => {
  it("uses the default only for providers that bill while running", () => {
    expect(
      sandboxHourlyCostMicros({ billsWhileRunning: () => true } as never, { kind: "e2b" }),
    ).toBe(SANDBOX_HOURLY_COST_MICROS);
    expect(sandboxHourlyCostMicros({} as SandboxProvider, { kind: "docker" })).toBe(0);
  });

  it("never charges for a host computer", () => {
    const sandbox = { billsWhileRunning: () => true } as never;
    expect(sandboxHourlyCostMicros(sandbox, { kind: "desktop" })).toBe(0);
  });
});

describe("computer hours left", () => {
  it("shows whole hours, rounded down", () => {
    expect(sandboxHoursLeft({ limitMicros: 5_000_000, usedMicros: 2_250_000 })).toBe(13);
    expect(sandboxHoursLeft({ limitMicros: 5_000_000, usedMicros: 0 })).toBe(25);
  });

  it("shows tenths when less than an hour is left", () => {
    expect(sandboxHoursLeft({ limitMicros: 5_000_000, usedMicros: 4_900_000 })).toBe(0.5);
  });

  it("never goes below zero once spent", () => {
    expect(sandboxHoursLeft({ limitMicros: 5_000_000, usedMicros: 6_000_000 })).toBe(0);
  });
});

describe("plan computer size", () => {
  function sizeFor(
    mode: string | null,
    billing: { status: string | null; byokTier: string | null; byokPriceCents?: number } | null,
  ) {
    const prisma = {
      space: {
        findUnique: vi.fn().mockResolvedValue({
          organization: {
            modelCredits: mode ? { mode } : null,
            billing: billing && { byokPriceCents: null, ...billing },
          },
        }),
      },
    };
    return planComputerSize(prisma as unknown as PrismaClient, "space");
  }

  it("starts computers at a live own-key tier's size", async () => {
    expect(await sizeFor("byok", { status: "active", byokTier: "pro" })).toBe("large");
    expect(await sizeFor("byok", { status: "trialing", byokTier: "max" })).toBe("xlarge");
    expect(await sizeFor("byok", { status: "active", byokTier: "standard" })).toBe("standard");
    expect(
      await sizeFor("credits", { status: "active", byokTier: "max", byokPriceCents: 9900 }),
    ).toBe("xlarge");
  });

  it("keeps credits, lapsed plans and plans without a tier standard", async () => {
    expect(await sizeFor("credits", { status: "active", byokTier: null })).toBe("standard");
    expect(await sizeFor("byok", { status: "canceled", byokTier: "max" })).toBe("standard");
    expect(await sizeFor("byok", { status: "trialing", byokTier: null })).toBe("standard");
    expect(await sizeFor("byok", null)).toBe("standard");
    expect(await sizeFor(null, null)).toBe("standard");
  });
});
