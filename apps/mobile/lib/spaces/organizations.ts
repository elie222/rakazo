import type { MenuAction } from "@expo/ui/community/menu";
import { t } from "@lingui/core/macro";
import type { OrganizationList } from "@rakazo/contracts";
import { organizationLandingSpaceId, organizationOfSpace } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { selectedSpaceId } from "../api/api";
import {
  adoptDeletedSpaceFallback,
  loadOrganizationSpaces,
  rememberOrganizationSpace,
  selectSpace,
} from "../api/api-server";
import { navigatorMounted } from "../navigation/navigator-mounted";
import { queryClient, removeSpaceQueries, rpcQuery } from "../query/query";

export type Organization = OrganizationList["organizations"][number];
type GuestSpace = NonNullable<OrganizationList["guestSpaces"]>[number];

const ORGANIZATION_ACTION_PREFIX = "organization:";
const GUEST_SPACE_ACTION_PREFIX = "guest-space:";

let switchEpoch = 0;
const switchListeners = new Set<() => void>();

/** Bumped after the selection moves to another organization, so the inbox remounts. */
export function organizationSwitchEpoch(): number {
  return switchEpoch;
}

export function subscribeOrganizationSwitch(listener: () => void): () => void {
  switchListeners.add(listener);
  return () => {
    switchListeners.delete(listener);
  };
}

function noteOrganizationSwitch(): void {
  switchEpoch += 1;
  for (const listener of [...switchListeners]) listener();
}

/** A server without organizations refuses the list, so it is not asked again. */
function organizationsQuery() {
  return {
    ...rpcQuery("organizations/list"),
    retry: (failures: number, error: Error) => {
      const status = (error as { status?: number }).status;
      return failures < 2 && (status === undefined || status >= 500);
    },
  };
}

/** Servers without organizations never answer, which hides every organization control. */
export function useOrganizations(enabled = true) {
  return useQuery({ ...organizationsQuery(), enabled }, queryClient);
}

/** Loads the list when it is missing or stale, as after a failed first try. */
export function ensureOrganizations(): Promise<void> {
  return queryClient.prefetchQuery(organizationsQuery());
}

/** The organization of the selected Space, which the server's answer may not have caught up to. */
export function activeOrganization(list: OrganizationList | undefined): Organization | undefined {
  if (!list || activeGuestSpace(list)) return undefined;
  return (
    organizationOfSpace(list.organizations, selectedSpaceId()) ??
    list.organizations.find((organization) => organization.id === list.activeOrganizationId)
  );
}

export function activeGuestSpace(list: OrganizationList | undefined): GuestSpace | undefined {
  const spaceId = selectedSpaceId();
  return list?.guestSpaces?.find((space) => space.id === spaceId);
}

export function refreshOrganizations(): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[3] === "organizations/list",
  });
}

/**
 * After the server says organizations may have changed: their list, any members list shown, and
 * what their plan or computer sizes decide.
 */
export function refreshOrganizationReads(): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey.includes("organizations/list") ||
      queryKey.includes("organizations/members/list") ||
      queryKey.includes("billing/status") ||
      queryKey.includes("cloudComputers/list"),
  });
}

/** Switcher actions, available when there is more than one destination. */
export function organizationSwitchActions(list: OrganizationList | undefined): MenuAction[] {
  if (!list || list.organizations.length + (list.guestSpaces?.length ?? 0) < 2) return [];
  return organizationActions(list);
}

/** Organizations and guest Spaces, with a check on the active context. */
export function organizationActions(list: OrganizationList | undefined): MenuAction[] {
  if (!list) return [];
  const active = activeOrganization(list);
  const guest = activeGuestSpace(list);
  return [
    ...list.organizations.map(
      (organization): MenuAction => ({
        id: `${ORGANIZATION_ACTION_PREFIX}${organization.id}`,
        title: organization.name,
        state: organization.id === active?.id ? "on" : "off",
      }),
    ),
    ...(list.guestSpaces ?? []).map(
      (space): MenuAction => ({
        id: `${GUEST_SPACE_ACTION_PREFIX}${space.id}`,
        title: t`${space.name} (Guest)`,
        state: space.id === guest?.id ? "on" : "off",
      }),
    ),
  ];
}

export function organizationForAction(
  list: OrganizationList | undefined,
  action: string,
): Organization | undefined {
  if (!action.startsWith(ORGANIZATION_ACTION_PREFIX)) return undefined;
  const id = action.slice(ORGANIZATION_ACTION_PREFIX.length);
  return list?.organizations.find((organization) => organization.id === id);
}

export function guestSpaceForAction(
  list: OrganizationList | undefined,
  action: string,
): GuestSpace | undefined {
  if (!action.startsWith(GUEST_SPACE_ACTION_PREFIX)) return undefined;
  const id = action.slice(GUEST_SPACE_ACTION_PREFIX.length);
  return list?.guestSpaces?.find((space) => space.id === id);
}

function returnHome(): void {
  if (!navigatorMounted()) return;
  if (router.canDismiss()) router.dismissAll();
  router.replace("/");
}

async function enterSpace(spaceId: string, leaving: Organization | undefined): Promise<boolean> {
  const current = selectedSpaceId();
  if (leaving && current) await rememberOrganizationSpace(leaving.id, current);
  if (!(await selectSpace(spaceId).catch(() => false))) return false;
  if (leaving) removeSpaceQueries(leaving.spaceIds);
  else if (current && current !== spaceId) removeSpaceQueries([current]);
  void refreshOrganizations();
  noteOrganizationSwitch();
  return true;
}

let switching: Promise<boolean> | null = null;

/**
 * Opens `target` where this device last left it, and returns to its inbox. A pick made while a
 * switch is still under way waits for it, then switches again, so the last pick wins.
 */
export function switchOrganization(
  target: Organization,
  organizations: readonly Organization[],
): Promise<boolean> {
  return afterPendingSwitch(() => switchNow(target, organizations));
}

export function switchGuestSpace(
  target: GuestSpace,
  organizations: readonly Organization[],
): Promise<boolean> {
  return afterPendingSwitch(async () => {
    const current = selectedSpaceId();
    if (current === target.id) return true;
    if (!(await enterSpace(target.id, organizationOfSpace(organizations, current)))) return false;
    returnHome();
    return true;
  });
}

async function afterPendingSwitch(run: () => Promise<boolean>): Promise<boolean> {
  const previous = switching;
  const next = (async () => {
    await previous?.catch(() => false);
    return run();
  })();
  switching = next;
  try {
    return await next;
  } finally {
    if (switching === next) switching = null;
  }
}

async function switchNow(
  target: Organization,
  organizations: readonly Organization[],
): Promise<boolean> {
  const leaving = organizationOfSpace(organizations, selectedSpaceId());
  if (leaving?.id === target.id) return true;
  const landing = organizationLandingSpaceId(target, await loadOrganizationSpaces());
  if (!(await enterSpace(landing, leaving))) return false;
  returnHome();
  return true;
}

/**
 * Selects a Space a notification or link points at. One in another organization switches to it,
 * remembering where this one was left; the opened chat stays on top. A failed list read falls
 * back to the last one this session had, so the Space being left is still remembered.
 */
export async function selectSpaceAcrossOrganizations(spaceId: string): Promise<boolean> {
  const query = organizationsQuery();
  const list =
    (await queryClient.fetchQuery({ ...query, retry: false }).catch(() => undefined)) ??
    queryClient.getQueryData(query.queryKey);
  return afterPendingSwitch(async () => {
    const current = selectedSpaceId();
    const leaving = organizationOfSpace(list?.organizations ?? [], current);
    if (
      current === spaceId ||
      leaving?.spaceIds.includes(spaceId) ||
      (!leaving && !activeGuestSpace(list))
    )
      return selectSpace(spaceId);
    return enterSpace(spaceId, leaving);
  });
}

/**
 * After the server deleted `deleted`, opens the Space it chose and returns to the inbox. Throws,
 * leaving the screen in place, when no Space could be selected.
 */
export async function leaveDeletedOrganization(
  deleted: Organization,
  activeSpaceId: string,
): Promise<void> {
  const selected =
    (await selectSpace(activeSpaceId).catch(() => false)) ||
    (await adoptDeletedSpaceFallback(activeSpaceId));
  if (!selected) throw new Error(t`Could not switch spaces`);
  removeSpaceQueries(deleted.spaceIds);
  void refreshOrganizations();
  noteOrganizationSwitch();
  returnHome();
}
