import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { provisionPhoneIdentity } from "./phone.js";

describe("provisionPhoneIdentity", () => {
  it("returns the existing identity without creating anything when already provisioned", async () => {
    const existing = {
      id: "pi-1",
      phoneE164: "+15551234567",
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-1",
      verifiedAt: null,
      lastInboundAt: null,
      outboundSinceInbound: 0,
      createdAt: new Date("2026-08-28T00:00:00.000Z"),
      updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    };
    const prisma = {
      phoneIdentity: { findUnique: vi.fn(async () => existing) },
      thread: { findFirst: vi.fn(async () => ({ id: "thread-1" })) },
      user: { create: vi.fn() },
    };
    const result = await provisionPhoneIdentity(prisma as unknown as PrismaClient, "+15551234567", {
      signupsEnabled: undefined,
      signupAllowlist: undefined,
    });

    expect(result).toEqual({
      phoneE164: "+15551234567",
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-1",
      threadId: "thread-1",
      created: false,
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("rejects numbers that are not valid E.164", async () => {
    const prisma = { phoneIdentity: { findUnique: vi.fn() } };
    for (const bad of ["15551234567", "+1 (555) 123-4567", "hello", "+0123"]) {
      await expect(
        provisionPhoneIdentity(prisma as unknown as PrismaClient, bad, {
          signupsEnabled: undefined,
          signupAllowlist: undefined,
        }),
      ).rejects.toThrow(/E\.164/);
    }
    expect(prisma.phoneIdentity.findUnique).not.toHaveBeenCalled();
  });

  it("throws instead of returning an empty thread id when the thread is missing", async () => {
    const existing = {
      id: "pi-1",
      phoneE164: "+15551234567",
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-1",
      verifiedAt: null,
      lastInboundAt: null,
      outboundSinceInbound: 0,
      createdAt: new Date("2026-08-28T00:00:00.000Z"),
      updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    };
    const prisma = {
      phoneIdentity: { findUnique: vi.fn(async () => existing) },
      thread: { findFirst: vi.fn(async () => null) },
    };
    await expect(
      provisionPhoneIdentity(prisma as unknown as PrismaClient, "+15551234567", {
        signupsEnabled: undefined,
        signupAllowlist: undefined,
      }),
    ).rejects.toThrow(/thread/i);
  });
});

describe("provisionPhoneIdentity create race", () => {
  it("resolves the thread for the winning identity's bot, not the loser's", async () => {
    const winner = {
      id: "pi-winner",
      phoneE164: "+15551234567",
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-winner",
    };
    const prisma = {
      phoneIdentity: {
        findUnique: vi
          .fn()
          .mockImplementationOnce(async () => null)
          .mockImplementationOnce(async () => winner),
        create: vi.fn(async () => {
          throw new Error("Unique constraint failed on the fields: (`phoneE164`)");
        }),
      },
      user: { findUnique: vi.fn(async () => ({ id: "user-1", email: "phone-x@phone.invalid" })) },
      member: { findFirst: vi.fn(async () => ({ organizationId: "ws-1" })) },
      bot: { findFirst: vi.fn(async () => ({ id: "bot-loser" })) },
      thread: {
        findFirst: vi.fn(async ({ where }: { where: { botId: string } }) =>
          where.botId === "bot-winner" ? { id: "thread-winner" } : { id: "thread-loser" },
        ),
      },
    };
    const result = await provisionPhoneIdentity(prisma as unknown as PrismaClient, "+15551234567", {
      signupsEnabled: undefined,
      signupAllowlist: undefined,
    });

    expect(result).toEqual({
      phoneE164: "+15551234567",
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-winner",
      threadId: "thread-winner",
      created: false,
    });
  });
});
