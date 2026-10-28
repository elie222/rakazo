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
