import { parseMeetingLink } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { googleMeetLinks } from "./google-meet-link.js";

const parse = (input: string) => parseMeetingLink(input, [googleMeetLinks]);

describe("Google Meet links", () => {
  it("reads a meeting code and drops the rest of the query", () => {
    expect(parse("https://meet.google.com/abc-defg-hij?authuser=1")).toEqual({
      provider: "google-meet",
      id: "abc-defg-hij",
      url: "https://meet.google.com/abc-defg-hij",
    });
  });

  it.each([
    ["a look-alike host", "https://meet.google.com.evil.com/abc-defg-hij"],
    ["a subdomain of a host that has none", "https://x.meet.google.com/abc-defg-hij"],
    ["the landing page", "https://meet.google.com/"],
    ["a wrong code", "https://meet.google.com/landing"],
    ["a code with a path after it", "https://meet.google.com/abc-defg-hij/extra"],
    ["plain http", "http://meet.google.com/abc-defg-hij"],
  ])("rejects %s", (_name, link) => {
    expect(parse(link)).toBeNull();
  });
});
