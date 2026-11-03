import type { MenuAction } from "@expo/ui/community/menu";
import type { OrganizationList } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import {
  adoptDeletedSpaceFallback,
  loadOrganizationSpaces,
  rememberOrganizationSpace,
  selectedSpaceId,
  selectSpace,
} from "./api";
import { queryClient, removeSpaceQueries, rpcQuery } from "./query";

export type Organization = OrganizationList["organizations"][number];

export const CREATE_ORGANIZATION_ACTION = "create-organization";
const ORGANIZATION_ACTION_PREFIX = "organization:";

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

/** Servers without organizations never answer, which hides every organization control. */
export function useOrganizations(enabled = true) {
  return useQuery({ ...rpcQuery("organizations/list"), retry: false, enabled }, queryClient);
}

export function activeOrganization(list: OrganizationList | undefined): Organization | undefined {
  return list?.organizations.find((organization) => organization.id === list.activeOrganizationId);
}

export function refreshOrganizations(): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[3] === "organizations/list",
  });
}

export function organizationOfSpace(
  organizations: readonly Organization[],
  spaceId: string | null,
): Organization | undefined {
  return spaceId
    ? organizations.find((organization) => organization.spaceIds.includes(spaceId))
    : undefined;
}

/** The Space last used in the organization on this device, else its default. */
export function organizationLanding(
  target: Organization,
  remembered: Readonly<Record<string, string>>,
): string {
  const spaceId = remembered[target.id];
  return spaceId && target.spaceIds.includes(spaceId) ? spaceId : target.defaultSpaceId;
}

/** Organization rows with a check on the active one; none until there is a second. */
export function organizationSwitchActions(list: OrganizationList | undefined): MenuAction[] {
  if (!list || list.organizations.length < 2) return [];
  return list.organizations.map((organization) => ({
    id: `${ORGANIZATION_ACTION_PREFIX}${organization.id}`,
    title: organization.name,
    state: organization.id === list.activeOrganizationId ? "on" : "off",
  }));
}

export function organizationForAction(
  list: OrganizationList | undefined,
  action: string,
): Organization | undefined {
  if (!action.startsWith(ORGANIZATION_ACTION_PREFIX)) return undefined;
  const id = action.slice(ORGANIZATION_ACTION_PREFIX.length);
  return list?.organizations.find((organization) => organization.id === id);
}

function returnHome(): void {
  if (router.canDismiss()) router.dismissAll();
  router.replace("/");
}

async function enterSpace(spaceId: string, leaving: Organization | undefined): Promise<boolean> {
  const current = selectedSpaceId();
  if (leaving && current) await rememberOrganizationSpace(leaving.id, current);
  if (!(await selectSpace(spaceId).catch(() => false))) return false;
  if (leaving) removeSpaceQueries(leaving.spaceIds);
  noteOrganizationSwitch();
  return true;
}

/** Opens `target` where this device last left it, and returns to its inbox. */
export async function switchOrganization(
  target: Organization,
  organizations: readonly Organization[],
): Promise<boolean> {
  const leaving = organizationOfSpace(organizations, selectedSpaceId());
  if (leaving?.id === target.id) return true;
  const landing = organizationLanding(target, await loadOrganizationSpaces());
  if (!(await enterSpace(landing, leaving))) return false;
  returnHome();
  return true;
}

/**
 * Selects a Space a notification or link points at. One in another organization switches to it,
 * remembering where this one was left; the opened chat stays on top.
 */
export async function selectSpaceAcrossOrganizations(spaceId: string): Promise<boolean> {
  const list = await queryClient
    .fetchQuery({ ...rpcQuery("organizations/list"), retry: false })
    .catch(() => undefined);
  const leaving = organizationOfSpace(list?.organizations ?? [], selectedSpaceId());
  if (!leaving || leaving.spaceIds.includes(spaceId)) return selectSpace(spaceId);
  return enterSpace(spaceId, leaving);
}

/** After the server deleted `deleted`, opens the Space it chose and returns to the inbox. */
export async function leaveDeletedOrganization(
  deleted: Organization,
  activeSpaceId: string,
): Promise<boolean> {
  const selected =
    (await selectSpace(activeSpaceId).catch(() => false)) ||
    (await adoptDeletedSpaceFallback(activeSpaceId));
  removeSpaceQueries(deleted.spaceIds);
  noteOrganizationSwitch();
  returnHome();
  return selected;
}
