import type { AppBootstrap } from "@rakazo/contracts";

export function initialBootstrapTarget(pathname: string, desktop: boolean) {
  const appRoute = pathname === "/app" || pathname.startsWith("/app/");
  if (!appRoute && !(desktop && pathname === "/")) return null;
  return { botId: appRoute ? botIdFromPath(pathname) : undefined };
}

function botIdFromPath(pathname: string) {
  const segments = pathname.split("/");
  if (["g", "artifacts", "board", "x"].includes(segments[2] ?? "")) return undefined;
  const encoded = segments[2];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/** The other Space to open when the linked bot is the user's but not in the Space just loaded. */
export function linkedBotSpaceId(
  bootstrap: Pick<AppBootstrap, "botSpaceId" | "bots" | "me">,
  botId: string | undefined,
): string | undefined {
  if (!botId || !bootstrap.botSpaceId || bootstrap.botSpaceId === bootstrap.me.spaceId)
    return undefined;
  return bootstrap.bots.some((bot) => bot.id === botId) ? undefined : bootstrap.botSpaceId;
}
