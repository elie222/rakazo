import type { MeetingPlatform } from "@rakazo/contracts";

export const meetingPlatformNames: Record<MeetingPlatform, string> = {
  zoom: "Zoom",
  google_meet: "Google Meet",
};

export function meetingTargetFromUrl(input: string): {
  platform: MeetingPlatform;
  url: string;
  key: string;
} | null {
  const url = URL.parse(input.trim());
  if (url?.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (
    url.hostname === "meet.google.com" &&
    /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(url.pathname)
  ) {
    const key = url.pathname.toLowerCase().replace(/\/$/, "");
    return { platform: "google_meet", url: `https://meet.google.com${key}`, key };
  }
  if (url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us")) {
    const number = /^\/(?:j|wc\/join)\/(\d{9,11})\/?$/.exec(url.pathname)?.[1];
    if (number) {
      const password = url.searchParams.get("pwd");
      const join = new URL(`https://${url.hostname}/j/${number}`);
      if (password) join.searchParams.set("pwd", password);
      return { platform: "zoom", url: join.href, key: number };
    }
  }
  return null;
}
