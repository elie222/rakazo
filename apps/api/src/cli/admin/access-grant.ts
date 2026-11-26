import type { ByokTier } from "@rakazo/contracts";
import { BYOK_TIERS, ByokTierSchema } from "@rakazo/contracts";
import {
  activeFreeByokTier,
  FREE_BYOK_ACCOUNT_SELECT,
  hasBillingAccess,
  isOwnerRole,
  needsBillingPortal,
  publishOrganizationChange,
} from "@rakazo/db";
import { applyAccessGrants, createAccessGrant } from "../../auth/access-grants.js";
import { adminEmail, findAdminAccount } from "./account-target.js";
import type { AdminCommand, AdminContext } from "./admin-command.js";

export const accessGrantCommand: AdminCommand = {
  path: ["access", "grant"],
  usage: `<email> <free-months> [${ByokTierSchema.options.join("|")}]`,
  flags: [],
  parse: ([address, months, requestedTier, ...extra]) => {
    const email = adminEmail(address);
    const freeMonths = /^\d{1,2}$/.test(months ?? "") ? Number(months) : 0;
    const tier = ByokTierSchema.safeParse(requestedTier).data;
    if (
      !email ||
      extra.length ||
      freeMonths < 1 ||
      freeMonths > 12 ||
      (requestedTier !== undefined && !tier)
    )
      return null;
    return (context) => grantAccess(context, email, freeMonths, tier);
  },
};

async function grantAccess(
  { prisma, realtime }: AdminContext,
  email: string,
  freeMonths: number,
  tier: ByokTier | undefined,
) {
  const user = await findAdminAccount(prisma, email);
  const grant = await createAccessGrant(prisma, null, { email: user.email, freeMonths }, tier);
  const memberships = await prisma.member.findMany({
    where: { userId: user.id, role: { contains: "owner" } },
    select: { organizationId: true, role: true },
  });
  const owned = memberships.filter((member) => isOwnerRole(member.role));
  const onlyOrganizationId = owned.length === 1 ? owned[0]?.organizationId : undefined;
  if (onlyOrganizationId)
    await applyAccessGrants(prisma, {
      userId: user.id,
      email: user.email,
      organizationId: onlyOrganizationId,
    });
  const applied = await prisma.accessGrant.findUniqueOrThrow({
    where: { id: grant.id },
    select: { appliedAt: true, organizationId: true },
  });
  const organizationId = applied.appliedAt ? applied.organizationId : null;
  const organization = organizationId
    ? await prisma.organization.findUnique({
        where: { id: organizationId },
        select: {
          modelCredits: {
            select: { ...FREE_BYOK_ACCOUNT_SELECT, byokFreeUntil: true },
          },
          billing: { select: { status: true } },
        },
      })
    : null;
  if (organizationId)
    await publishOrganizationChange(prisma, realtime, organizationId, [], { waitForPublish: true });
  const credits = organization?.modelCredits;
  const subscriptionStatus = organization?.billing?.status ?? null;
  const subscriptionTakesPrecedence =
    hasBillingAccess(subscriptionStatus) || needsBillingPortal(subscriptionStatus);
  const expiry = tier
    ? credits?.freeByokTiers.find((grant) => grant.tier === tier)?.expiresAt
    : credits?.byokFreeUntil;
  const freeUntil = expiry ?? null;
  const counting = tier
    ? activeFreeByokTier(credits, subscriptionStatus)?.tier === tier
    : credits?.mode === "byok" && !subscriptionTakesPrecedence;
  const plan = tier ? `Own-key ${BYOK_TIERS[tier].name} plan` : "Own-key plan";
  const inactive = tier
    ? subscriptionTakesPrecedence
      ? " An existing subscription takes precedence."
      : credits?.mode !== "byok"
        ? " These benefits apply when using your own API key."
        : " A higher free tier currently applies."
    : " It counts only while the organization uses its own key without a subscription.";
  const text = freeUntil
    ? `${plan} free until ${freeUntil.toISOString()}.${counting ? "" : inactive}`
    : `${plan} grant saved. It applies the next time the account's owner opens billing.`;
  return {
    text,
    json: {
      grantId: grant.id,
      organizationId,
      freeUntil: freeUntil?.toISOString() ?? null,
      counting: Boolean(freeUntil) && counting,
      ...(tier && { tier }),
    },
  };
}
