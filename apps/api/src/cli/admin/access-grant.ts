import { PostgresRealtimeFanout } from "@rakazo/adapters";
import { publishOrganizationChange, recordAuditEvent } from "@rakazo/db";
import { applyAccessGrants, createAccessGrant } from "../../auth/access-grants.js";
import { adminEmail, findAdminAccount } from "./account-target.js";
import type { AdminCommand, AdminContext } from "./admin-command.js";

export const accessGrantCommand: AdminCommand = {
  path: ["access", "grant"],
  usage: "<email> <free-months>",
  flags: [],
  parse: ([address, months, ...extra]) => {
    const email = adminEmail(address);
    const freeMonths = /^\d{1,2}$/.test(months ?? "") ? Number(months) : 0;
    if (!email || extra.length || freeMonths < 1 || freeMonths > 12) return null;
    return (context) => grantAccess(context, email, freeMonths);
  },
};

async function grantAccess(context: AdminContext, email: string, freeMonths: number) {
  const { prisma } = context;
  const user = await findAdminAccount(prisma, email);
  const grant = await createAccessGrant(prisma, null, { email: user.email, freeMonths });
  await recordAuditEvent({
    action: "access_grant.created",
    actor: { type: "system", label: "operator" },
    target: { type: "access_grant", id: grant.id },
    metadata: { freeMonths },
  });
  const owned = await prisma.member.findMany({
    where: { userId: user.id, role: { contains: "owner" } },
    select: { organizationId: true },
    take: 2,
  });
  const organizationId = owned.length === 1 ? owned[0]?.organizationId : undefined;
  if (organizationId) {
    await applyAccessGrants(prisma, { userId: user.id, email: user.email, organizationId });
    await signalOrganization(context, organizationId);
  }
  const [applied, credits] = await Promise.all([
    prisma.accessGrant.findUniqueOrThrow({ where: { id: grant.id }, select: { appliedAt: true } }),
    organizationId
      ? prisma.modelCreditAccount.findUnique({
          where: { organizationId },
          select: { mode: true, byokFreeUntil: true },
        })
      : null,
  ]);
  const freeUntil = applied.appliedAt ? (credits?.byokFreeUntil ?? null) : null;
  const text = freeUntil
    ? `Own-key plan free until ${freeUntil.toISOString()}.${credits?.mode === "byok" ? "" : " It counts only while the organization uses its own key."}`
    : "Grant saved. It applies the next time the account's owner opens billing.";
  return {
    text,
    json: {
      grantId: grant.id,
      organizationId: applied.appliedAt ? organizationId : null,
      freeUntil: freeUntil?.toISOString() ?? null,
    },
  };
}

async function signalOrganization({ prisma, pool, env }: AdminContext, organizationId: string) {
  const realtime = new PostgresRealtimeFanout({
    connectionString: env.realtimeDatabaseUrl,
    publisher: pool,
  });
  try {
    await publishOrganizationChange(prisma, realtime, organizationId);
  } finally {
    await realtime.close();
  }
}
