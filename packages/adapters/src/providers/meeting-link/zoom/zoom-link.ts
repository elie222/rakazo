import type { MeetingLinkRecognizer } from "@rakazo/core";
import { meetingTokenParam } from "@rakazo/core";

const HOSTS = ["zoom.us", "zoomgov.com"];

const zoomId = (text: string | undefined): text is string =>
  text !== undefined && text.length >= 9 && text.length <= 11 && /^\d+$/.test(text);

/**
 * Zoom meeting links on any subdomain of its hosts, keeping the passcode. Not covered: personal
 * room links (`/my/<name>`).
 */
export const zoomLinks: MeetingLinkRecognizer = {
  id: "zoom",
  recognize: ({ host, segments, query }) => {
    if (!HOSTS.some((name) => host === name || host.endsWith(`.${name}`))) return undefined;
    const [first, second, third] = segments;
    const id =
      (first === "j" || first === "w") && segments.length === 2 && zoomId(second)
        ? second
        : first === "wc" && second === "join" && segments.length === 3 && zoomId(third)
          ? third
          : undefined;
    if (!id) return undefined;
    return { id, params: { pwd: meetingTokenParam(query, "pwd") } };
  },
};
