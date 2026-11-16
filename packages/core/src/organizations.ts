import type { OrganizationList, SpaceMembers } from "@rakazo/contracts";

type Organization = OrganizationList["organizations"][number];

/** The Space last used in the organization on this device, else its default. */
export function organizationLandingSpaceId(
  organization: Organization,
  savedSpaceIds: Readonly<Record<string, string>>,
): string {
  const saved = savedSpaceIds[organization.id];
  return saved && organization.spaceIds.includes(saved) ? saved : organization.defaultSpaceId;
}

export function organizationOfSpace(
  organizations: readonly Organization[],
  spaceId: string | null | undefined,
): Organization | undefined {
  return spaceId
    ? organizations.find((organization) => organization.spaceIds.includes(spaceId))
    : undefined;
}

/**
 * Its owner can delete it while nobody else belongs to it and they still own another
 * organization to land in.
 */
export function canDeleteOrganization(
  organizations: readonly Organization[],
  organization: Organization,
): boolean {
  return (
    organization.canManage &&
    organization.memberCount === 1 &&
    organizations.filter((each) => each.canManage).length > 1
  );
}

/** The owner and admins invite people, change their roles and remove them. */
export function canManageOrganizationMembers(organization: Organization): boolean {
  return organization.role !== "member";
}

/**
 * Who an address typed into a Space's invite belongs to: someone already in the Space, someone in
 * its organization to add directly, or someone from outside, who joins this Space alone. Null
 * until it reads as an address.
 */
export function spaceInvitee(
  list: Pick<SpaceMembers, "members" | "addable">,
  email: string,
): { kind: "member" } | { kind: "addable"; userId: string } | { kind: "outside" } | null {
  const address = email.trim().toLowerCase();
  // Split, not a regular expression, so a long pasted string costs linear time.
  const [local, domain = "", extra] = address.split("@");
  const dot = domain.lastIndexOf(".");
  // The invite takes at most 254 characters, the longest address mail can carry.
  if (!local || extra !== undefined || address.length > 254 || /\s/.test(address)) return null;
  if (dot < 1 || dot === domain.length - 1) return null;
  const owns = (person: { email: string }) => person.email.toLowerCase() === address;
  if (list.members.some(owns)) return { kind: "member" };
  const person = list.addable?.find(owns);
  return person ? { kind: "addable", userId: person.userId } : { kind: "outside" };
}
