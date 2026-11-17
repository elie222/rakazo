import { parseMeetingLink } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { teamsLinks } from "./teams-link.js";

const parse = (input: string) => parseMeetingLink(input, [teamsLinks]);
const thread = "19%3ameeting_AbC%40thread.v2";
const join = `https://teams.microsoft.com/l/meetup-join/${thread}`;

describe("Microsoft Teams links", () => {
  it("reads a meet link and keeps the passcode only", () => {
    expect(parse("https://teams.live.com/meet/9876543210123?p=abc&x=1")).toEqual({
      provider: "microsoft-teams",
      id: "9876543210123",
      url: "https://teams.live.com/meet/9876543210123?p=abc",
    });
  });

  it("reads a meetup-join link with or without its number", () => {
    expect(parse(`${join}/0`)).toMatchObject({ id: "19:meeting_AbC@thread.v2" });
    expect(parse(join)).toMatchObject({ id: "19:meeting_AbC@thread.v2" });
  });

  it("gives differently encoded copies of one thread one id", () => {
    const lower = parse(`${join}/0`);
    const upper = parse("https://teams.microsoft.com/l/meetup-join/19%3Ameeting_AbC%40thread.v2/0");
    const plain = parse("https://teams.microsoft.com/l/meetup-join/19:meeting_AbC@thread.v2/0");
    expect(upper?.id).toBe(lower?.id);
    expect(plain?.id).toBe(lower?.id);
  });

  it.each(["x", "..%2f..%2fevil", "%E0%A4%A", "19%3ameeting_%40thread.v9"])(
    "rejects %s as a thread id",
    (segment) => {
      expect(parse(`https://teams.microsoft.com/l/meetup-join/${segment}/0`)).toBeNull();
    },
  );

  it.each([
    ["an arbitrary page after the number", `${join}/0/not-a-meeting-page`],
    ["a suffix that is not a number", `${join}/abc`],
    ["two suffixes", `${join}/0/1`],
    ["a number that is too short", "https://teams.live.com/meet/123"],
    ["a sign-in page", "https://teams.microsoft.com/"],
    ["an empty meetup-join", "https://teams.microsoft.com/l/meetup-join/"],
    ["a subdomain of a host that has none", "https://x.teams.live.com/meet/9876543210123"],
  ])("rejects %s", (_name, link) => {
    expect(parse(link)).toBeNull();
  });

  it("keeps a whole context and drops one that was cut off", () => {
    const context = encodeURIComponent('{"Tid":"t","Oid":"o"}');
    expect(parse(`${join}/0?context=${context}`)?.url).toBe(`${join}/0?context=${context}`);
    expect(parse(`${join}/0?context=${encodeURIComponent('{"Tid":"t"')}`)?.url).toBe(`${join}/0`);
  });
});
