import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";

describe("provisionMessagingIdentity", () => {
  it("returns the existing identity without creating anything when already provisioned", async () => {
    const existing = {
      id: "mi-1",
      provider: "sendblue",
      address: "+15551234567",
      dmThreadId: null,
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-1",
      verifiedAt: null,
      lastInboundAt: null,
      outboundSinceInbound: 0,
      createdAt: new Date("2026-08-28T00:00:00.000Z"),
      updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    };
    const prisma = {
      messagingIdentity: { findUnique: vi.fn(async () => existing) },
      thread: { findFirst: vi.fn(async () => ({ id: "thread-1" })) },
      user: { create: vi.fn() },
    };
    const result = await provisionMessagingIdentity(
      prisma as unknown as PrismaClient,
      { provider: "sendblue", address: "+15551234567" },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );

    expect(result).toEqual({
      provider: "sendblue",
      address: "+15551234567",
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-1",
      threadId: "thread-1",
      created: false,
    });
    expect(prisma.messagingIdentity.findUnique).toHaveBeenCalledWith({
      where: { provider_address: { provider: "sendblue", address: "+15551234567" } },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("rejects malformed addresses", async () => {
    const prisma = { messagingIdentity: { findUnique: vi.fn() } };
    for (const bad of ["", "+1 (555) 123-4567", "has space", "a".repeat(129)]) {
      await expect(
        provisionMessagingIdentity(
          prisma as unknown as PrismaClient,
          { provider: "sendblue", address: bad },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
      ).rejects.toThrow(/Invalid messaging address/);
    }
    expect(prisma.messagingIdentity.findUnique).not.toHaveBeenCalled();
  });

  it("throws instead of returning an empty thread id when the thread is missing", async () => {
    const existing = {
      id: "mi-1",
      provider: "sendblue",
      address: "+15551234567",
      dmThreadId: null,
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-1",
      verifiedAt: null,
      lastInboundAt: null,
      outboundSinceInbound: 0,
      createdAt: new Date("2026-08-28T00:00:00.000Z"),
      updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    };
    const prisma = {
      messagingIdentity: { findUnique: vi.fn(async () => existing) },
      thread: { findFirst: vi.fn(async () => null) },
    };
    await expect(
      provisionMessagingIdentity(
        prisma as unknown as PrismaClient,
        { provider: "sendblue", address: "+15551234567" },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    ).rejects.toThrow(/thread/i);
  });
});

describe("provisionMessagingIdentity create race", () => {
  it("resolves the thread for the winning identity's bot, not the loser's", async () => {
    const winner = {
      id: "mi-winner",
      provider: "sendblue",
      address: "+15551234567",
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-winner",
    };
    const prisma = {
      messagingIdentity: {
        findUnique: vi
          .fn()
          .mockImplementationOnce(async () => null)
          .mockImplementationOnce(async () => winner),
        create: vi.fn(async () => {
          throw new Error("Unique constraint failed on the fields: (`provider`,`address`)");
        }),
      },
      user: {
        findUnique: vi.fn(async () => ({
          id: "user-1",
          email: "msg-sendbluex@messaging.invalid",
        })),
      },
      spaceMember: { findFirst: vi.fn(async () => ({ spaceId: "ws-1" })) },
      bot: { findFirst: vi.fn(async () => ({ id: "bot-loser" })) },
      thread: {
        findFirst: vi.fn(async ({ where }: { where: { botId: string } }) =>
          where.botId === "bot-winner" ? { id: "thread-winner" } : { id: "thread-loser" },
        ),
      },
    };
    const result = await provisionMessagingIdentity(
      prisma as unknown as PrismaClient,
      { provider: "sendblue", address: "+15551234567" },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );

    expect(result).toEqual({
      provider: "sendblue",
      address: "+15551234567",
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-winner",
      threadId: "thread-winner",
      created: false,
    });
  });
});

describe("messaging link codes", () => {
  it("normalizes exactly-one-code messages and rejects everything else", async () => {
    const { normalizeMessagingLinkCode } = await import("./messaging.js");
    expect(normalizeMessagingLinkCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizeMessagingLinkCode("  ABCD 2345 ")).toBe("ABCD2345");
    expect(normalizeMessagingLinkCode("hello there")).toBeNull();
    expect(normalizeMessagingLinkCode("ABCD2345 please")).toBeNull();
    expect(normalizeMessagingLinkCode("ABCD234")).toBeNull();
    expect(normalizeMessagingLinkCode("")).toBeNull();
  });

  it("formats codes for humans and round-trips through normalization", async () => {
    const { formatMessagingLinkCode, normalizeMessagingLinkCode } = await import("./messaging.js");
    expect(formatMessagingLinkCode("ABCD2345")).toBe("ABCD-2345");
    expect(normalizeMessagingLinkCode(formatMessagingLinkCode("ABCD2345"))).toBe("ABCD2345");
  });
});
