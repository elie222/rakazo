export function zoomMeetingLink(url: URL) {
  if (url.hostname !== "zoom.us" && !url.hostname.endsWith(".zoom.us")) return null;

  const key = /^\/(?:j|wc\/join)\/(\d{9,11})\/?$/.exec(url.pathname)?.[1];
  if (!key) return null;

  const join = new URL(`https://${url.hostname}/j/${key}`);
  const password = url.searchParams.get("pwd");
  if (password) join.searchParams.set("pwd", password);
  return { platform: "zoom" as const, url: join.href, key };
}
