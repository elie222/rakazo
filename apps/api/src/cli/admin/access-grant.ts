import { hasBillingAccess, isOwnerRole } from "@rakazo/db";
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

async function grantAccess({ prisma }: AdminContext, email: string, freeMonths: number) {
  const user = await findAdminAccount(prisma, email);
  const grant = await createAccessGrant(prisma, null, { email: user.email, freeMonths });
  const memberships = await prisma.member.findMany({
    where: { userId: user.id, role: { contains: "owner" } },
    select: { organizationId: true, role: true },
  });
  const owned = memberships.filter((member) => isOwnerRole(member.role));
  const organizationId = owned.length === 1 ? owned[0]?.organizationId : undefined;
  if (organizationId)
    await applyAccessGrants(prisma, { userId: user.id, email: user.email, organizationId });
  const [applied, organization] = await Promise.all([
    prisma.accessGrant.findUniqueOrThrow({ where: { id: grant.id }, select: { appliedAt: true } }),
    organizationId
      ? prisma.organization.findUnique({
          where: { id: organizationId },
          select: {
            modelCredits: { select: { mode: true, byokFreeUntil: true } },
            billing: { select: { status: true } },
          },
        })
      : null,
  ]);
  const freeUntil = applied.appliedAt ? (organization?.modelCredits?.byokFreeUntil ?? null) : null;
  const counting =
    organization?.modelCredits?.mode === "byok" &&
    !hasBillingAccess(organization.billing?.status ?? null);
  const text = freeUntil
    ? `Own-key plan free until ${freeUntil.toISOString()}.${counting ? "" : " It counts only while the organization uses its own key without a subscription."}`
    : "Grant saved. It applies the next time the account's owner opens billing.";
  return {
    text,
    json: {
      grantId: grant.id,
      organizationId: applied.appliedAt ? organizationId : null,
      freeUntil: freeUntil?.toISOString() ?? null,
      counting: Boolean(freeUntil) && counting,
    },
  };
}
