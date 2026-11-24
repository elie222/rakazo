import type { MediaGenerationProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  hostedMediaPrice,
  hostedMediaWithinAllowance,
  priceMediaGeneration,
} from "./media-usage.js";

const provider = { prices: { imageMicros: 40_000, videoMicros: 0 } } as MediaGenerationProvider;

function prisma(input: {
  billing: boolean;
  status?: string;
  chargedMicros?: number;
  pendingMicros?: number;
  pendingCharged?: boolean;
}) {
  return {
    externalEffect: {
      findMany: vi.fn().mockResolvedValue(
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
        billing: input.status
          ? { status: input.status, byokTier: "standard", byokPriceCents: 1500 }
          : null,
      }),
    },
    mediaCharge: {
      findMany: vi.fn().mockResolvedValue(input.pendingCharged ? [{ source: "media:job" }] : []),
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountMicros: input.chargedMicros ?? 0 } }),
    },
  } as unknown as PrismaClient;
}

describe("hosted media pricing", () => {
  it("meters nothing where billing is off", async () => {
    expect(
      await priceMediaGeneration(prisma({ billing: false }), provider, "space", "image"),
    ).toEqual({ charge: null });
  });

  it("charges a paid plan the provider's price while its media balance covers it", async () => {
    expect(
      await priceMediaGeneration(
        prisma({ billing: true, status: "active" }),
        provider,
        "space",
        "image",
      ),
    ).toEqual({ charge: { organizationId: "org", micros: 40_000 } });
  });

  it("refuses once the media balance cannot cover the price", async () => {
    const spent = prisma({ billing: true, status: "active", chargedMicros: 980_000 });
    expect(await priceMediaGeneration(spent, provider, "space", "image")).toHaveProperty("error");
  });

  it("counts videos still running against the balance", async () => {
    const busy = prisma({ billing: true, status: "active", pendingMicros: 980_000 });
    expect(await priceMediaGeneration(busy, provider, "space", "image")).toHaveProperty("error");
  });

  it("counts a running video once its charge is written", async () => {
    const charged = prisma({
      billing: true,
      status: "active",
      pendingMicros: 980_000,
      pendingCharged: true,
    });
    expect(await priceMediaGeneration(charged, provider, "space", "image")).toHaveProperty(
      "charge",
    );
  });

  it("refuses during a trial", async () => {
    const trial = prisma({ billing: true, status: "trialing" });
    expect(await priceMediaGeneration(trial, provider, "space", "image")).toHaveProperty("error");
  });

  it("refuses without a paid plan", async () => {
    const none = prisma({ billing: true });
    expect(await priceMediaGeneration(none, provider, "space", "image")).toHaveProperty("error");
  });

  it("never refuses what the provider gives away", async () => {
    const trial = prisma({ billing: true, status: "trialing" });
    expect(await priceMediaGeneration(trial, provider, "space", "video")).toEqual({
      charge: null,
    });
  });

  it("never prices media made with the owner's own connection", () => {
    const own = { record: { kind: "connection", connectionId: "c" } as const, provider };
    expect(hostedMediaPrice(prisma({ billing: true }), own, "space")).toBeUndefined();
  });
  it("stops offering hosted media one generation of which costs more than the monthly balance", async () => {
    const dear = {
      capabilities: { images: true, video: true, offline: false },
      prices: { imageMicros: 40_000, videoMicros: 1_600_000 },
      generateImage: vi.fn(),
    } as unknown as MediaGenerationProvider;
    const metered = await hostedMediaWithinAllowance(prisma({ billing: true }), dear);
    expect(metered?.capabilities).toEqual({ images: true, video: false, offline: false });
    expect(metered?.generateImage).toBe(dear.generateImage);
    expect(await hostedMediaWithinAllowance(prisma({ billing: false }), dear)).toBe(dear);
  });
});
