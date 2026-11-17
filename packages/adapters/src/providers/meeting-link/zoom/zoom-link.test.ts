import { parseMeetingLink } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { zoomLinks } from "./zoom-link.js";

const parse = (input: string) => parseMeetingLink(input, [zoomLinks]);

describe("Zoom links", () => {
  it("reads any subdomain and keeps the passcode only", () => {
    expect(parse("https://us02web.zoom.us/j/81234567890?pwd=SeCrEt&from=addon&uname=Ann")).toEqual({
      provider: "zoom",
      id: "81234567890",
      url: "https://us02web.zoom.us/j/81234567890?pwd=SeCrEt",
    });
    expect(parse("https://zoom.us/wc/join/81234567890")?.id).toBe("81234567890");
    expect(parse("https://zoom.us/w/81234567890")?.id).toBe("81234567890");
    expect(parse("https://meet.zoomgov.com/j/1612345678")?.provider).toBe("zoom");
  });

  it("gives two links to one meeting the same id", () => {
    expect(parse("https://zoom.us/j/81234567890")?.id).toBe(
      parse("https://us06web.zoom.us/j/81234567890?pwd=x")?.id,
    );
  });

  it("reads an id with an encoded digit", () => {
    expect(parse("https://zoom.us/j/8123456789%30")?.id).toBe("81234567890");
  });

  it("drops a passcode that is not a bare token", () => {
    expect(parse("https://zoom.us/j/81234567890?pwd=a!b")?.url).toBe(
      "https://zoom.us/j/81234567890",
    );
  });

  it.each([
    ["a host that only ends like the service", "https://evilzoom.us/j/81234567890"],
    ["the service as a subdomain of another site", "https://zoom.us.evil.com/j/81234567890"],
    ["a login that names the service", "https://zoom.us@evil.com/j/81234567890"],
    ["a page that is not a meeting", "https://zoom.us/pricing"],
    ["an id that is too short", "https://zoom.us/j/123"],
    ["an id that is not a number", "https://zoom.us/j/abcdefghij"],
    ["a personal room", "https://zoom.us/my/ann"],
    ["extra path after a meeting", "https://zoom.us/j/81234567890/extra"],
  ])("rejects %s", (_name, link) => {
    expect(parse(link)).toBeNull();
  });
});
