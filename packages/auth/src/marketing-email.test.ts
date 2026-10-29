import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReferralEmailReconciler, unsubscribeUrl } from "./marketing-email.js";

const DAY = 86_400_000;
const now = new Date("2026-10-29T12:00:00Z");
const secret = "test-auth-secret-at-least-32-characters";
const origin = "https://app.example.com";

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const sent = new Set<string>();
  const user = { email: "alex@example.com", name: "Alex", members: [{ role: "owner" }] };
  const findMany = vi.fn(async () => [{ id: "user-1" }]);
  const findFirst = vi.fn(async (): Promise<typeof user | null> => user);
  const createMany = vi.fn(async ({ data }: { data: { userId: string; kind: string } }) => {
    const key = `${data.userId}:${data.kind}`;
    if (sent.has(key)) return { count: 0 };
    sent.add(key);
    return { count: 1 };
  });
  const email = { send: vi.fn(async () => {}) } as unknown as TransactionalEmailProvider;
  const settings = { referralsEnabled: true };
  const deps = {
    prisma: {
      user: { findMany, findFirst },
      emailSend: { createMany },
      deploymentSettings: { findUnique: async () => settings },
    } as never,
    email: email as TransactionalEmailProvider | undefined,
    enabled: true,
    replyTo: "support@example.com",
    origin,
    secret,
    onError: vi.fn(),
  };
  return {
    settings,
    deps,
    findMany,
    findFirst,
    createMany,
    reconcile: createReferralEmailReconciler(deps),
  };
}

afterEach(() => vi.useRealTimers());

describe("day-one referral reconciliation", () => {
  it("selects verified owners aged 24–72 hours with consent and no previous send", async () => {
    const f = fixture();
    await f.reconcile();
    expect(f.findMany).toHaveBeenCalledWith({
      where: {
        createdAt: { gte: new Date(now.getTime() - 3 * DAY), lte: new Date(now.getTime() - DAY) },
        emailVerified: true,
        email: { contains: "@" },
        marketingEmailOptOutAt: null,
        members: { some: { role: { contains: "owner" } } },
        emailSends: { none: { kind: "referral-day1" } },
      },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
    });
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "user-1",
          marketingEmailOptOutAt: null,
          emailVerified: true,
        }),
      }),
    );
    expect(f.createMany).toHaveBeenCalledWith({
      data: { userId: "user-1", kind: "referral-day1" },
      skipDuplicates: true,
    });
    expect(f.deps.email!.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alex@example.com",
        subject: "Invite a friend",
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl(origin, secret, "user-1")}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    );
  });

  it("never sends twice across concurrent passes, retries or a new reconciler", async () => {
    const f = fixture();
    await Promise.all([f.reconcile(), f.reconcile()]);
    await createReferralEmailReconciler(f.deps)();
    expect(f.deps.email!.send).toHaveBeenCalledTimes(1);
  });

  it("keeps the claim after uncertain delivery instead of sending again", async () => {
    const f = fixture();
    vi.mocked(f.deps.email!.send).mockRejectedValue(new Error("delivery failed"));
    await f.reconcile();
    await f.reconcile();
    expect(f.deps.email!.send).toHaveBeenCalledTimes(1);
    expect(f.deps.onError).toHaveBeenCalledTimes(1);
  });

  it.each([
    "product mail disabled",
    "no email",
    "no billing",
    "referrals disabled",
    "no reply address",
  ])("skips quietly: %s", async (reason) => {
    const f = fixture();
    if (reason === "product mail disabled") f.deps.enabled = false;
    if (reason === "no email") f.deps.email = undefined;
    if (reason === "no billing") f.settings.referralsEnabled = false;
    if (reason === "referrals disabled") f.settings.referralsEnabled = false;
    if (reason === "no reply address") f.deps.replyTo = " ";
    await f.reconcile();
    expect(f.findMany).not.toHaveBeenCalled();
    expect(f.deps.onError).not.toHaveBeenCalled();
  });

  it("does not send if eligibility changes before the claim", async () => {
    const f = fixture();
    f.findFirst.mockResolvedValue(null);
    await f.reconcile();
    expect(f.createMany).not.toHaveBeenCalled();
    expect(f.deps.email!.send).not.toHaveBeenCalled();
  });

  it("skips an unusable address", async () => {
    const f = fixture();
    f.findFirst.mockResolvedValue({
      email: "invalid@",
      name: "Alex",
      members: [{ role: "owner" }],
    });
    await f.reconcile();
    expect(f.createMany).not.toHaveBeenCalled();
  });
});
