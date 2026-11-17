import type { AppBootstrap } from "@rakazo/contracts";

export function initialBootstrapTarget(path: string, desktop: boolean) {
  const pathname = path.split(/[?#]/)[0] ?? "";
  const appRoute = pathname === "/app" || pathname.startsWith("/app/");
  if (!appRoute && !(desktop && pathname === "/")) return null;
  return {
    botId: appRoute ? botIdFromPath(pathname) : undefined,
    groupId: appRoute ? groupIdFromPath(pathname) : undefined,
  };
}

function botIdFromPath(pathname: string) {
  const segments = pathname.split("/");
  if (["g", "artifacts", "board", "x"].includes(segments[2] ?? "")) return undefined;
  return decoded(segments[2]);
}

function groupIdFromPath(pathname: string) {
  const segments = pathname.split("/");
  return segments[2] === "g" ? decoded(segments[3]) : undefined;
}

function decoded(segment: string | undefined) {
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Where to open a linked bot that is the user's but not in the Space just loaded. The link's
 * query (a message to jump to, a routine) comes along.
 */
export function linkedBotRoute(
  bootstrap: Pick<AppBootstrap, "botSpaceId" | "bots" | "me">,
  botId: string | undefined,
  search: string,
): { spaceId: string; path: string } | undefined {
  if (!botId || !bootstrap.botSpaceId || bootstrap.botSpaceId === bootstrap.me.spaceId)
    return undefined;
  if (bootstrap.bots.some((bot) => bot.id === botId)) return undefined;
  return { spaceId: bootstrap.botSpaceId, path: `/app/${encodeURIComponent(botId)}${search}` };
}

/** Where to open a linked group that the user can open, but not in the Space just loaded. */
export function linkedGroupRoute(
  bootstrap: Pick<AppBootstrap, "groupSpaceId" | "groups" | "me">,
  groupId: string | undefined,
  search: string,
): { spaceId: string; path: string } | undefined {
  if (!groupId || !bootstrap.groupSpaceId || bootstrap.groupSpaceId === bootstrap.me.spaceId)
    return undefined;
  if (bootstrap.groups.some((group) => group.id === groupId)) return undefined;
  return {
    spaceId: bootstrap.groupSpaceId,
    path: `/app/g/${encodeURIComponent(groupId)}${search}`,
  };
}
