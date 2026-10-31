import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SANDBOX_HOURLY_COST_MICROS,
  sandboxAllowance,
  sandboxHourlyCostMicros,
  sandboxHoursLeft,
} from "./sandbox-allowance.js";

function allowanceDeps(input: {
  billing: boolean;
  mode: string | null;
  creditAmountCents?: number | null;
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
          input.creditAmountCents === undefined
            ? null
            : { creditAmountCents: input.creditAmountCents },
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

  it("gives an own-key organization $5 a month", async () => {
    const { deps } = allowanceDeps({
      billing: true,
      mode: "byok",
      hours: [{ kind: "daytona", hours: 2.5 }],
    });
    expect(await sandboxAllowance(deps, "organization")).toEqual({
      limitMicros: 5_000_000,
      usedMicros: 2.5 * DEFAULT_SANDBOX_HOURLY_COST_MICROS,
    });
  });

  it("gives a monthly credit plan a fifth of its amount", async () => {
    const { deps } = allowanceDeps({ billing: true, mode: "credits", creditAmountCents: 5000 });
    expect((await sandboxAllowance(deps, "organization"))?.limitMicros).toBe(10_000_000);
  });

  it("gives nothing without a monthly plan", async () => {
    const { deps } = allowanceDeps({ billing: true, mode: "credits", creditAmountCents: null });
    expect((await sandboxAllowance(deps, "organization"))?.limitMicros).toBe(0);
  });

  it("counts the month from its first day, up to now", async () => {
    const { deps, prisma } = allowanceDeps({ billing: true, mode: "byok" });
    const now = new Date("2026-03-17T08:30:00.000Z");
    await sandboxAllowance(deps, "organization", now);
    const values = prisma.$queryRaw.mock.calls[0]?.slice(1);
    expect(values).toContainEqual(new Date("2026-03-01T00:00:00.000Z"));
    expect(values).toContainEqual(now);
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

describe("computer hourly cost", () => {
  it("uses the default only for providers that bill while running", () => {
    expect(
      sandboxHourlyCostMicros({ billsWhileRunning: () => true } as never, { kind: "e2b" }),
    ).toBe(DEFAULT_SANDBOX_HOURLY_COST_MICROS);
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
