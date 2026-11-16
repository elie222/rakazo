import type { OrganizationList } from "@rakazo/contracts";

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
