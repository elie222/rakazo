import type { MediaGenerationProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { priceMediaGeneration } from "./media-usage.js";

const provider = { prices: { imageMicros: 40_000, videoMicros: 0 } } as MediaGenerationProvider;

function deps(input: {
  billing: boolean;
  status?: string;
  chargedMicros?: number;
  pendingMicros?: number;
}) {
  const prisma = {
    externalEffect: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          input.pendingMicros
            ? [
                {
                  id: "job",
                  request: { charge: { organizationId: "org", micros: input.pendingMicros } },
                },
              ]
            : [],
        ),
    },
    space: { findUnique: vi.fn().mockResolvedValue({ organizationId: "org" }) },
    deploymentSettings: {
      findUnique: vi.fn().mockResolvedValue({ modelCreditsEnabled: input.billing }),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        modelCredits: { mode: "byok" },
        billing: input.status ? { status: input.status, cancelAtPeriodEnd: false } : null,
      }),
    },
    computerAllowanceGrant: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: null } }),
    },
    includedUsageCharge: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountMicros: input.chargedMicros ?? 0 } }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return { prisma: prisma as unknown as PrismaClient };
}

describe("hosted media pricing", () => {
  it("meters nothing where billing is off", async () => {
    expect(
      await priceMediaGeneration(deps({ billing: false }), provider, "space", "image"),
    ).toEqual({ charge: null });
  });

  it("charges a paid plan the provider's price while its included usage covers it", async () => {
    expect(
      await priceMediaGeneration(
        deps({ billing: true, status: "active" }),
        provider,
        "space",
        "image",
      ),
    ).toEqual({ charge: { organizationId: "org", micros: 40_000 } });
  });

  it("refuses once included usage cannot cover the price", async () => {
    const spent = deps({ billing: true, status: "active", chargedMicros: 5_980_000 });
    expect(await priceMediaGeneration(spent, provider, "space", "image")).toHaveProperty("error");
  });

  it("counts generations still running against the balance", async () => {
    const busy = deps({ billing: true, status: "active", pendingMicros: 5_980_000 });
    expect(await priceMediaGeneration(busy, provider, "space", "image")).toHaveProperty("error");
  });

  it("refuses during a trial", async () => {
    const trial = deps({ billing: true, status: "trialing" });
    expect(await priceMediaGeneration(trial, provider, "space", "image")).toHaveProperty("error");
  });

  it("never refuses what the provider gives away", async () => {
    const trial = deps({ billing: true, status: "trialing" });
    expect(await priceMediaGeneration(trial, provider, "space", "video")).toEqual({ charge: null });
  });
});
