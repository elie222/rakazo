import { findMeetingLinks, parseMeetingLink } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { googleMeetLinks } from "../providers/meeting-link/google-meet/google-meet-link.js";
import { teamsLinks } from "../providers/meeting-link/microsoft-teams/teams-link.js";
import { zoomLinks } from "../providers/meeting-link/zoom/zoom-link.js";

/** What every meeting link recognizer owes the shared contract, whichever service it reads. */
const recognizers = {
  "google-meet": {
    recognizer: googleMeetLinks,
    meeting: "https://meet.google.com/abc-defg-hij",
    id: "abc-defg-hij",
    notMeeting: "https://meet.google.com/landing",
  },
  zoom: {
    recognizer: zoomLinks,
    meeting: "https://zoom.us/j/81234567890",
    id: "81234567890",
    notMeeting: "https://zoom.us/pricing",
  },
  "microsoft-teams": {
    recognizer: teamsLinks,
    meeting: "https://teams.live.com/meet/9876543210123",
    id: "9876543210123",
    notMeeting: "https://teams.live.com/pricing",
  },
};

describe.each(Object.entries(recognizers))("%s link recognizer", (name, spec) => {
  const parse = (input: unknown) => parseMeetingLink(input, [spec.recognizer]);

  it("names itself and reads the meeting id", () => {
    expect(spec.recognizer.id).toBe(name);
    expect(name).toMatch(/^(google-?meet|zoom|microsoft-?teams)$/);
    expect(parse(spec.meeting)).toEqual({ provider: name, id: spec.id, url: spec.meeting });
  });

  it("reads nothing from a page that is not a meeting, another scheme, a login or a port", () => {
    expect(parse(spec.notMeeting)).toBeNull();
    expect(parse(spec.meeting.replace("https:", "http:"))).toBeNull();
    expect(parse(spec.meeting.replace("://", "://user@"))).toBeNull();
    expect(parse(spec.meeting.replace(/(\.[a-z]+)\//, "$1:8443/"))).toBeNull();
  });

  it("reads each of two links that touch with punctuation", () => {
    const other = "https://meet.google.com/zzz-yyyy-xxx";
    const found = findMeetingLinks(`${other},${spec.meeting}`, [googleMeetLinks, spec.recognizer]);
    expect(found.map((link) => link.id)).toContain(spec.id);
  });
});
