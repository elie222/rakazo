import type { JobPublisher, TransactionalEmail } from "@rakazo/adapter-kit";
import { lifecycleEmailJob } from "@rakazo/adapter-kit";
import { agentImportEmail, emailLocale, modelConnectionEmail } from "@rakazo/auth";
import type { LifecycleEmailKind } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { unsubscribeUrl } from "./marketing-email.js";

/** How long after a plan starts the model-connection mail is due. */
export const MODEL_CONNECTION_EMAIL_DELAY_MS = 24 * 60 * 60 * 1000;

/** How long after a plan starts the agent-import mail is due: a day after the one above. */
export const AGENT_IMPORT_EMAIL_DELAY_MS = 2 * MODEL_CONNECTION_EMAIL_DELAY_MS;

/** Queues a lifecycle mail for an organization's owner; present only where some mail is on. */
export type ScheduleLifecycleEmail = (
  kind: LifecycleEmailKind,
  target: { organizationId: string; userId: string },
  dueAt: Date,
) => Promise<void>;

/** A new lifecycle mail adds its kind to `LIFECYCLE_EMAIL_KINDS` and its template here. */
const TEMPLATES: Record<
  LifecycleEmailKind,
  (
    user: { email: string; name: string },
    links: { webOrigin: string; unsubscribeUrl: string },
    locale: string,
  ) => Promise<TransactionalEmail>
> = {
  "model-connection": modelConnectionEmail,
  "agent-import": agentImportEmail,
};

/**
 * Every lifecycle mail is scheduled through here: a caller names who and when. The message is
 * written now, by the process that holds the templates and the unsubscribe key, and the job
 * re-checks the facts before it sends. Scheduling the same kind for the same person again
 * moves their one job.
 */
export function lifecycleEmailScheduler(deps: {
  /** The kinds whose copy the deployment supplies; any other kind is never queued. */
  kinds: readonly LifecycleEmailKind[];
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue">;
  webOrigin: string;
  /** The API's own origin and the key that signs unsubscribe links. */
  origin: string;
  secret: string;
}): ScheduleLifecycleEmail {
  return async (kind, target, dueAt) => {
    if (!deps.kinds.includes(kind)) return;
    const user = await deps.prisma.user.findUnique({
      where: { id: target.userId },
      select: { email: true, name: true, locale: true },
    });
    if (!user) return;
    const { subject, text, html, headers } = await TEMPLATES[kind](
      user,
      {
        webOrigin: deps.webOrigin,
        unsubscribeUrl: unsubscribeUrl(deps.origin, deps.secret, target.userId),
      },
      emailLocale(user.locale),
    );
    await deps.jobs.enqueue(
      lifecycleEmailJob({ kind, ...target, message: { subject, text, html, headers } }, dueAt),
    );
  };
}
