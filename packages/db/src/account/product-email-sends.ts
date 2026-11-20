import type { PrismaClient } from "../database/client.js";
import { runAsSystem } from "../database/row-security.js";

const REASON = "a person's product email sends";

/**
 * Claims one product mail for a person: at most once per kind, and never within `gapMs` of
 * another of their product mails. The person's row is locked for the check and the insert, so
 * two mails racing from different paths cannot both pass. `clearAt` is when the gap ends.
 */
export function claimProductEmail(
  prisma: PrismaClient,
  send: { userId: string; kind: string },
  gapMs: number,
): Promise<"claimed" | "skip" | { clearAt: Date }> {
  return runAsSystem(REASON, () =>
    prisma.$transaction(async (tx) => {
      // Account deletion waits on this lock, so the insert below cannot lose its user.
      const locked = await tx.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now" FROM "user" WHERE id=${send.userId} FOR NO KEY UPDATE`;
      const now = locked[0]?.now;
      if (!now) return "skip";
      const sends = await tx.emailSend.findMany({
        where: {
          userId: send.userId,
          OR: [{ kind: send.kind }, { sentAt: { gt: new Date(now.getTime() - gapMs) } }],
        },
        select: { kind: true, sentAt: true },
      });
      if (sends.some((sent) => sent.kind === send.kind)) return "skip";
      if (sends.length > 0) {
        const last = Math.max(...sends.map((sent) => sent.sentAt.getTime()));
        return { clearAt: new Date(last + gapMs) };
      }
      await tx.emailSend.create({ data: { ...send, sentAt: now } });
      return "claimed";
    }),
  );
}
