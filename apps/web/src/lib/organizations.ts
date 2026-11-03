import type { OrganizationList } from "@rakazo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { queryClient, spaceQueries, useQueryUserId } from "./query";
import { ORGANIZATION_SPACES_STORAGE_KEY, rpc, selectedSpaceId, selectSpace } from "./rpc";

export type Organization = OrganizationList["organizations"][number];

/** Organizations belong to the user, not to a Space, so their list is cached once per user. */
export function organizationsQuery(userId: string | null) {
  return queryOptions({
    queryKey: [`user:${userId ?? ""}`, "organizations"],
    queryFn: () => rpc.organizations.list(),
  });
}

export function useOrganizations() {
  const userId = useQueryUserId();
  // The pre-app pages (onboarding, plan choice) also read it, so it names its client.
  const { data } = useQuery(
    { ...organizationsQuery(userId), enabled: Boolean(userId) },
    queryClient,
  );
  const organizations = data?.organizations ?? [];
  const spaceId = selectedSpaceId();
  const activeOrganizationId =
    organizations.find((organization) => spaceId && organization.spaceIds.includes(spaceId))?.id ??
    data?.activeOrganizationId ??
    null;
  return { organizations, activeOrganizationId };
}

function lastSpaces(): Record<string, string> {
  try {
    const saved = JSON.parse(window.localStorage.getItem(ORGANIZATION_SPACES_STORAGE_KEY) ?? "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

function rememberSpace(organizationId: string, spaceId: string) {
  try {
    window.localStorage.setItem(
      ORGANIZATION_SPACES_STORAGE_KEY,
      JSON.stringify({ ...lastSpaces(), [organizationId]: spaceId }),
    );
  } catch {
    // Without storage the organization opens at its default Space next time.
  }
}

/** The Space last used in the organization on this device, or its default once that is gone. */
export function landingSpaceId(organization: Organization): string {
  const saved = lastSpaces()[organization.id];
  return saved && organization.spaceIds.includes(saved) ? saved : organization.defaultSpaceId;
}

/**
 * Called as the selection moves from one Space to another. Crossing into another organization
 * remembers where the user was in the one being left and drops what was cached for its Spaces.
 */
export function leaveOrganization(
  userId: string | null,
  fromSpaceId: string | null | undefined,
  toSpaceId: string,
): void {
  if (!fromSpaceId || fromSpaceId === toSpaceId) return;
  const organizations = queryClient.getQueryData(
    organizationsQuery(userId).queryKey,
  )?.organizations;
  const from = organizations?.find((organization) => organization.spaceIds.includes(fromSpaceId));
  const to = organizations?.find((organization) => organization.spaceIds.includes(toSpaceId));
  if (!from || !to || from.id === to.id) return;
  rememberSpace(from.id, fromSpaceId);
  // The departing shell saves its Space's seed as it unmounts, so this runs after it.
  window.setTimeout(() => {
    for (const spaceId of [...from.spaceIds, null]) {
      queryClient.removeQueries({ queryKey: spaceQueries(userId, spaceId).key() });
    }
  }, 0);
}

type OpenSpaceChat = (spaceId: string, path: string) => void;

/** Moves to a Space that may be in another organization: in place inside the shell, by loading the page outside it. */
export function openOrganizationSpace(
  userId: string | null,
  spaceId: string,
  path: string,
  openSpaceChat?: OpenSpaceChat,
): void {
  if (openSpaceChat) {
    openSpaceChat(spaceId, path);
    return;
  }
  leaveOrganization(userId, selectedSpaceId(), spaceId);
  if (selectSpace(spaceId)) window.location.assign(path);
}

export function switchOrganization(
  userId: string | null,
  target: Organization,
  openSpaceChat?: OpenSpaceChat,
): void {
  openOrganizationSpace(
    userId,
    landingSpaceId(target),
    openSpaceChat ? "/app" : "/",
    openSpaceChat,
  );
}
