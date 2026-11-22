import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHourlySweep } from "../http/hourly-sweep.js";
import { unsubscribeUrl } from "./marketing-email.js";
import { sendReferralEmails } from "./referral-email.js";

const DAY = 86_400_000;
const now = new Date("2026-10-29T12:00:00Z");
const secret = "test-auth-secret-at-least-32-characters";
const origin = "https://app.example.com";

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const sent = new Set<string>();
  let claiming: Promise<unknown> = Promise.resolve();
  const user = {
    id: "user-1",
    email: "alex@example.com",
    name: "Alex",
    members: [{ role: "owner" }],
  };
  const findMany = vi.fn(async () => [user]);
  const create = vi.fn(async ({ data }: { data: { userId: string; kind: string } }) => {
    sent.add(`${data.userId}:${data.kind}`);
  });
  // The claim's transaction: the person's row lock, their sends, then the insert.
  const tx = {
    $queryRaw: async () => [{ now }],
    emailSend: {
      findMany: async ({
        where,
      }: {
        where: { userId: string; OR: [{ kind: string }, unknown] };
      }) =>
        sent.has(`${where.userId}:${where.OR[0].kind}`)
          ? [{ kind: where.OR[0].kind, sentAt: now }]
          : [],
      create,
    },
  };
  const email = { send: vi.fn(async () => {}) } as unknown as TransactionalEmailProvider;
  const deps = {
    prisma: {
      user: { findMany },
      // One at a time, as the person's row lock makes them.
      $transaction: (run: (client: typeof tx) => unknown) =>
        (claiming = claiming.then(() => run(tx))),
    } as never,
    email,
    appUrl: `${origin}/app`,
    origin,
    secret,
    onError: vi.fn(),
  };
  return { user, deps, findMany, create, sweep: sendReferralEmails(deps) };
}

afterEach(() => vi.useRealTimers());

describe("day-one referral email", () => {
  it("emails verified owners aged 24–72 hours with consent, no previous send and no other mail in the last day", async () => {
    const f = fixture();
    await f.sweep();
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date(now.getTime() - 3 * DAY),
            lte: new Date(now.getTime() - DAY),
          },
          emailVerified: true,
          marketingEmailOptOutAt: null,
          members: { some: { role: { contains: "owner" } } },
          emailSends: {
            none: {
              OR: [{ kind: "referral-day1" }, { sentAt: { gt: new Date(now.getTime() - DAY) } }],
            },
          },
        },
      }),
    );
    expect(f.create).toHaveBeenCalledWith({
      data: { userId: "user-1", kind: "referral-day1", sentAt: now },
    });
    expect(f.deps.email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alex@example.com",
        subject: "Invite a friend to Rakazo",
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl(origin, secret, "user-1")}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    );
  });

  it("never sends twice across concurrent sweeps or a retry", async () => {
    const f = fixture();
    await Promise.all([f.sweep(), f.sweep()]);
    await sendReferralEmails(f.deps)();
    expect(f.deps.email.send).toHaveBeenCalledTimes(1);
  });

  it("keeps the claim after uncertain delivery instead of sending again", async () => {
    const f = fixture();
    vi.mocked(f.deps.email.send).mockRejectedValue(new Error("delivery failed"));
    await f.sweep();
    await f.sweep();
    expect(f.deps.email.send).toHaveBeenCalledTimes(1);
    expect(f.deps.onError).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a role that only contains owner", { members: [{ role: "not-owner" }] }],
    ["an unusable address", { email: "invalid@" }],
  ])("skips %s", async (_, change) => {
    const f = fixture();
    Object.assign(f.user, change);
    await f.sweep();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("runs at startup and hourly without overlapping sweeps, aborting the running one on stop", async () => {
    vi.useFakeTimers();
    let running = deferred();
    const sweep = vi.fn((_signal: AbortSignal) => {
      running = deferred();
      return running.promise;
    });
    const stop = startHourlySweep(sweep, vi.fn());
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sweep).toHaveBeenCalledTimes(1);
    running.resolve();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    const signal = sweep.mock.calls[1]![0];
    const stopped = stop();
    expect(signal.aborted).toBe(true);
    running.resolve();
    await stopped;
  });
});
