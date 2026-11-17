import { findMeetingLinks } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { meetingLinkRecognizers } from "./meeting-link-recognizers.js";

describe("meetingLinkRecognizers", () => {
  it("finds Meet, Zoom and Teams links in an event, once per meeting", () => {
    const event = {
      summary: "Planning",
      location: "https://meet.google.com/abc-defg-hij",
      description:
        'Join <a href="https://us02web.zoom.us/j/81234567890?pwd=x&amp;from=addon">Zoom</a> or ' +
        "https://meet.google.com/abc-defg-hij.",
      attendees: [{ note: "Backup: https://teams.live.com/meet/9876543210123?p=abc)" }],
    };
    const found = findMeetingLinks(event, meetingLinkRecognizers);
    expect(found.map((link) => [link.provider, link.id])).toEqual([
      ["google-meet", "abc-defg-hij"],
      ["zoom", "81234567890"],
      ["microsoft-teams", "9876543210123"],
    ]);
    expect(found[1]?.url).toBe("https://us02web.zoom.us/j/81234567890?pwd=x");
    expect(found[2]?.url).toBe("https://teams.live.com/meet/9876543210123?p=abc");
  });

  it("ignores look-alike links next to a real one", () => {
    const text = "https://evilzoom.us/j/81234567890 https://zoom.us/j/81234567890";
    expect(findMeetingLinks(text, meetingLinkRecognizers)).toEqual([
      { provider: "zoom", id: "81234567890", url: "https://zoom.us/j/81234567890" },
    ]);
  });
});
