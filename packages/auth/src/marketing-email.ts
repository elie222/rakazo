import { createHmac, timingSafeEqual } from "node:crypto";
import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { ActorSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { referralEmail } from "./referral-email.js";

export const UNSUBSCRIBE_PATH = "/api/v1/email/unsubscribe";

function unsubscribeToken(secret: string, userId: string): string {
  return createHmac("sha256", secret).update(`marketing-unsubscribe:${userId}`).digest("base64url");
}

export function unsubscribeUrl(origin: string, secret: string, userId: string): string {
  const url = new URL(UNSUBSCRIBE_PATH, origin);
  url.searchParams.set("user", userId);
  url.searchParams.set("token", unsubscribeToken(secret, userId));
  return url.href;
}

export function validUnsubscribeToken(secret: string, userId: string, token: string): boolean {
  const expected = Buffer.from(unsubscribeToken(secret, userId));
  const actual = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const REFERRAL_EMAIL_KIND = "referral-day1";

export function createReferralEmailReconciler(deps: {
  prisma: PrismaClient;
  email?: TransactionalEmailProvider;
  enabled: boolean;
  replyTo?: string;
  origin: string;
  secret: string;
  onError: (error: unknown) => void;
}) {
  return async () => {
    if (!deps.enabled || !deps.email || !deps.replyTo?.trim()) return;
    const settings = await deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { referralsEnabled: true },
    });
    if (!settings?.referralsEnabled) return;
    const now = Date.now();
    const eligible = {
      createdAt: { gte: new Date(now - 3 * DAY_MS), lte: new Date(now - DAY_MS) },
      emailVerified: true,
      email: { contains: "@" },
      marketingEmailOptOutAt: null,
      members: { some: { role: { contains: "owner" } } },
      emailSends: { none: { kind: REFERRAL_EMAIL_KIND } },
    };
    const users = await deps.prisma.user.findMany({
      where: eligible,
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
    });
    await Promise.all(
      users.map(async ({ id }) => {
        try {
          // Recheck consent and ownership immediately before claiming delivery.
          const user = await deps.prisma.user.findFirst({
            where: { ...eligible, id },
            select: { email: true, name: true, members: { select: { role: true } } },
          });
          if (
            !user ||
            !ActorSchema.shape.email.safeParse(user.email).success ||
            !user.members.some(({ role }) =>
              role.split(",").some((value) => value.trim() === "owner"),
            )
          )
            return;
          const message = await referralEmail(
            user,
            new URL("/app", deps.origin).href,
            unsubscribeUrl(deps.origin, deps.secret, id),
          );
          // Persist before sending: an uncertain delivery must never be sent again.
          const claim = await deps.prisma.emailSend.createMany({
            data: { userId: id, kind: REFERRAL_EMAIL_KIND },
            skipDuplicates: true,
          });
          if (claim.count === 0) return;
          await deps.email!.send(message);
        } catch (error) {
          // Account deletion may race the foreign-key insert.
          if (error && typeof error === "object" && "code" in error && error.code === "P2003")
            return;
          deps.onError(error);
        }
      }),
    );
  };
}
