import type { MeetingLinkRecognizer } from "@rakazo/core";
import { meetingTokenParam } from "@rakazo/core";

const HOSTS = ["teams.microsoft.com", "teams.microsoft.us", "teams.live.com"];

const meetCode = (text: string | undefined): text is string =>
  text !== undefined && text.length >= 9 && text.length <= 15 && /^\d+$/.test(text);

/** A meetup-join thread id, decoded so that `%3a` and `%3A` name one meeting. */
function threadId(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  return /^19:meeting_[^/\s]+@thread\.(?:v2|skype)$/i.test(id) ? id : undefined;
}

/** Whether a `context` value is the JSON object it should be, and not a cut-off copy. */
function jsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Microsoft Teams `/meet/<number>` and `/l/meetup-join/<thread>[/<number>]` links, keeping the
 * passcode and a whole `context`. Not covered: the government Teams subdomains (only
 * `teams.microsoft.us` itself).
 */
export const teamsLinks: MeetingLinkRecognizer = {
  id: "microsoft-teams",
  recognize: ({ host, segments, query }) => {
    if (!HOSTS.includes(host)) return undefined;
    const [first, second, third, fourth] = segments;
    let id: string | undefined;
    if (first === "meet" && segments.length === 2 && meetCode(second)) id = second;
    else if (
      first === "l" &&
      second === "meetup-join" &&
      (segments.length === 3 || (segments.length === 4 && /^\d+$/.test(fourth ?? "")))
    ) {
      id = threadId(third);
    }
    if (!id) return undefined;
    const context = query.get("context");
    return {
      id,
      params: {
        p: meetingTokenParam(query, "p"),
        context: context && jsonObject(context) ? context : undefined,
      },
    };
  },
};
