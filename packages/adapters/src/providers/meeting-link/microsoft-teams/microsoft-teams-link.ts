export function microsoftTeamsLink(url: URL) {
  if (url.hostname !== "teams.microsoft.com" && url.hostname !== "teams.cloud.microsoft")
    return null;

  // Teams meeting IDs have grown from 12 to 16 digits; leave room for longer ones.
  const code = /^\/meet\/(\d{9,20})\/?$/.exec(url.pathname)?.[1];
  const thread =
    /^\/l\/meetup-join\/19(?::|%3a)meeting_((?:[a-z0-9_+=-]|%2[bf]|%3d)+)(?:@|%40)thread\.(v2|skype)\/\d+\/?$/i.exec(
      url.pathname,
    );
  const key =
    code ??
    (thread && `19:meeting_${decodeURIComponent(thread[1]!)}@thread.${thread[2]?.toLowerCase()}`);
  if (!key) return null;

  const join = new URL(url.pathname, url.origin);
  for (const parameter of ["p", "context"]) {
    const value = url.searchParams.get(parameter);
    if (value) join.searchParams.set(parameter, value);
  }
  return { platform: "microsoft_teams" as const, url: join.href, key };
}
