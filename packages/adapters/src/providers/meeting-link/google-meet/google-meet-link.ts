import type { MeetingLinkRecognizer } from "@rakazo/core";

/**
 * Google Meet meeting codes. Not covered: short links such as `g.co/meet`, and links wrapped by a
 * mail scanner's redirect.
 */
export const googleMeetLinks: MeetingLinkRecognizer = {
  id: "google-meet",
  recognize: ({ host, segments: [code, ...rest] }) =>
    host === "meet.google.com" &&
    rest.length === 0 &&
    code !== undefined &&
    /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code)
      ? { id: code, params: {} }
      : undefined,
};
