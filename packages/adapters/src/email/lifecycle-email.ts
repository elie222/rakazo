import type {
  BackgroundJobPayloads,
  JobPublisher,
  ProductAnalytics,
  TransactionalEmailProvider,
} from "@rakazo/adapter-kit";
import { lifecycleEmailJob } from "@rakazo/adapter-kit";
import type { LifecycleEmailKind } from "@rakazo/contracts";
import { ActorSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { claimProductEmail, hasBillingAccess, isOwnerRole } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** No person gets two of our mails closer together than this, whichever kinds they are. */
export const LIFECYCLE_EMAIL_GAP_MS = 24 * 60 * 60 * 1000;

type LifecycleEmailJob = BackgroundJobPayloads["email.lifecycle"];
type Target = Pick<LifecycleEmailJob, "organizationId" | "userId">;

/**
 * Whether each mail still applies when its job fires; the facts may have changed since it was
 * scheduled. A new lifecycle mail adds its kind to `LIFECYCLE_EMAIL_KINDS` and its check here.
 */
const STILL_WANTED: Record<
  LifecycleEmailKind,
  (prisma: PrismaClient, target: Target) => Promise<boolean>
> = {
  "model-connection": needsModelConnection,
};

/**
 * A paid or trialing own-key plan whose owner has connected no model. Hosted credits need no
 * connection, so an organization funded by them is left alone.
 */
async function needsModelConnection(prisma: PrismaClient, target: Target): Promise<boolean> {
  const [organization, connection] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: target.organizationId },
      select: {
        billing: { select: { status: true, creditAmountCents: true } },
        modelCredits: { select: { mode: true, balanceMicros: true } },
      },
    }),
    prisma.userModelCredential.findFirst({
      where: { userId: target.userId },
      select: { id: true },
    }),
  ]);
  if (!organization?.billing || connection) return false;
  if (!hasBillingAccess(organization.billing.status) || organization.billing.creditAmountCents)
    return false;
  const credits = organization.modelCredits;
  // An own-key organization runs on its own model whatever balance it kept.
  if (credits?.mode === "byok") return true;
  return credits?.mode !== "credits" && (credits?.balanceMicros ?? 0n) <= 0n;
}

/** The owner to write to, or null when they left, opted out, or the organization is going. */
async function recipient(prisma: PrismaClient, target: Target) {
  const [user, deleting] = await Promise.all([
    prisma.user.findFirst({
      where: {
        id: target.userId,
        emailVerified: true,
        marketingEmailOptOutAt: null,
        deactivatedAt: null,
      },
      select: {
        email: true,
        members: { where: { organizationId: target.organizationId }, select: { role: true } },
      },
    }),
    prisma.space.findFirst({
      where: { organizationId: target.organizationId, isDefault: true, deletingAt: { not: null } },
      select: { id: true },
    }),
  ]);
  if (!user || deleting || !user.members.some(({ role }) => isOwnerRole(role))) return null;
  return ActorSchema.shape.email.safeParse(user.email).success ? user : null;
}

/**
 * Answers the `email.lifecycle` job: sends the mail if it still applies, at most once per person
 * and kind. A mail due within the gap of the person's last one moves to the gap's end instead,
 * so a person's mails form one sequence in the order they come due.
 */
export function createLifecycleEmailSender(deps: {
  prisma: PrismaClient;
  email: TransactionalEmailProvider;
  jobs: Pick<JobPublisher, "enqueue">;
  analytics?: ProductAnalytics;
}): (job: LifecycleEmailJob) => Promise<void> {
  const { prisma } = deps;
  return async (job) => {
    const { kind, userId } = job;
    const user = await recipient(prisma, job);
    if (!user || !(await STILL_WANTED[kind](prisma, job))) return;
    const claim = await claimProductEmail(prisma, { userId, kind }, LIFECYCLE_EMAIL_GAP_MS);
    if (claim === "skip") return;
    if (claim !== "claimed") {
      await deps.jobs.enqueue(lifecycleEmailJob(job, claim.clearAt));
      return;
    }
    // Claimed before sending: a delivery that may have gone out is never repeated.
    try {
      await deps.email.send({ ...job.message, to: user.email });
    } catch (error) {
      getLogger().error("lifecycle email delivery failed", error, { "email.kind": kind });
      return;
    }
    deps.analytics?.capture(userId, { name: "lifecycle_email_sent", email: kind });
  };
}
