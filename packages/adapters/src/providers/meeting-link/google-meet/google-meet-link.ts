export function googleMeetLink(url: URL) {
  if (
    url.hostname !== "meet.google.com" ||
    !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(url.pathname)
  )
    return null;

  const key = url.pathname.toLowerCase().replace(/\/$/, "");
  return { platform: "google_meet" as const, url: `https://meet.google.com${key}`, key };
}
