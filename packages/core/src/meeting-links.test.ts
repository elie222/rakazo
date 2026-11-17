import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import { findMeetingLinks, parseMeetingLink } from "./meeting-links.js";

describe("parseMeetingLink", () => {
  it("reads a Google Meet code", () => {
    expect(parseMeetingLink("https://meet.google.com/abc-defg-hij?authuser=1")).toEqual({
      service: "meet",
      id: "abc-defg-hij",
      url: "https://meet.google.com/abc-defg-hij",
    });
  });

  it("reads Zoom links on any of its subdomains and keeps the passcode only", () => {
    expect(
      parseMeetingLink("https://us02web.zoom.us/j/81234567890?pwd=SeCrEt&from=addon&uname=Ann"),
    ).toEqual({
      service: "zoom",
      id: "81234567890",
      url: "https://us02web.zoom.us/j/81234567890?pwd=SeCrEt",
    });
    expect(parseMeetingLink("https://zoom.us/wc/join/81234567890")?.id).toBe("81234567890");
    expect(parseMeetingLink("https://meet.zoomgov.com/j/1612345678")?.service).toBe("zoom");
  });

  it("reads Teams meet and meetup-join links", () => {
    expect(parseMeetingLink("https://teams.live.com/meet/9876543210123?p=abc&x=1")).toEqual({
      service: "teams",
      id: "9876543210123",
      url: "https://teams.live.com/meet/9876543210123?p=abc",
    });
    const join =
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d";
    expect(parseMeetingLink(join)).toMatchObject({
      service: "teams",
      id: "19:meeting_abc@thread.v2",
    });
  });

  it("normalizes case, a trailing dot on the host, a trailing slash and the fragment", () => {
    expect(parseMeetingLink("  HTTPS://ZOOM.US./j/81234567890/#top  ")).toEqual({
      service: "zoom",
      id: "81234567890",
      url: "https://zoom.us/j/81234567890",
    });
  });

  it("gives two links to one meeting the same id", () => {
    expect(parseMeetingLink("https://zoom.us/j/81234567890")?.id).toBe(
      parseMeetingLink("https://us06web.zoom.us/j/81234567890?pwd=x")?.id,
    );
  });

  it.each([
    ["a host that only ends like the service", "https://evilzoom.us/j/81234567890"],
    [
      "a service name used as a subdomain of another site",
      "https://zoom.us.evil.com/j/81234567890",
    ],
    ["a Meet look-alike", "https://meet.google.com.evil.com/abc-defg-hij"],
    ["a login that names the service", "https://zoom.us@evil.com/j/81234567890"],
    ["a login on the real host", "https://user:pass@zoom.us/j/81234567890"],
    ["a port", "https://zoom.us:8443/j/81234567890"],
    ["a subdomain of a host that has none", "https://x.meet.google.com/abc-defg-hij"],
    ["plain http", "http://meet.google.com/abc-defg-hij"],
    ["another scheme", "javascript://meet.google.com/abc-defg-hij"],
    ["a service page that is not a meeting", "https://zoom.us/pricing"],
    ["the Meet landing page", "https://meet.google.com/"],
    ["a Meet path with a wrong code", "https://meet.google.com/landing"],
    ["a Meet code with a path after it", "https://meet.google.com/abc-defg-hij/extra"],
    ["a Zoom id that is too short", "https://zoom.us/j/123"],
    ["a Zoom id that is not a number", "https://zoom.us/j/abcdefghij"],
    ["a Teams sign-in page", "https://teams.microsoft.com/"],
    ["an empty meetup-join", "https://teams.microsoft.com/l/meetup-join/"],
  ])("rejects %s", (_name, link) => {
    expect(parseMeetingLink(link)).toBeNull();
  });

  it("returns null instead of throwing for input that is not a link", () => {
    for (const input of [undefined, null, "", "   ", 12, {}, [], "https://[", "not a url"]) {
      expect(parseMeetingLink(input)).toBeNull();
    }
  });
});

describe("findMeetingLinks", () => {
  it("finds links in text, markup and nested event fields, in order, once per meeting", () => {
    const event = {
      summary: "Planning",
      location: "https://meet.google.com/abc-defg-hij",
      description:
        'Join <a href="https://us02web.zoom.us/j/81234567890?pwd=x&amp;from=addon">Zoom</a> or ' +
        "https://meet.google.com/abc-defg-hij.",
      attendees: [{ note: "Backup: https://teams.live.com/meet/9876543210123?p=abc)" }],
    };
    expect(findMeetingLinks(event).map((link) => [link.service, link.id])).toEqual([
      ["meet", "abc-defg-hij"],
      ["zoom", "81234567890"],
      ["teams", "9876543210123"],
    ]);
    expect(findMeetingLinks(event)[1]?.url).toBe("https://us02web.zoom.us/j/81234567890?pwd=x");
  });

  it("returns nothing for empty or non-text values on every shape", () => {
    for (const value of [
      undefined,
      null,
      "",
      0,
      true,
      {},
      [],
      [[], {}, [null]],
      { a: undefined },
    ]) {
      expect(findMeetingLinks(value)).toEqual([]);
    }
  });

  it("ignores look-alike links next to a real one", () => {
    const text = "https://evilzoom.us/j/81234567890 https://zoom.us/j/81234567890";
    expect(findMeetingLinks(text)).toEqual([
      { service: "zoom", id: "81234567890", url: "https://zoom.us/j/81234567890" },
    ]);
  });

  it("does not read class instances or loop on a cycle", () => {
    const cycle: Record<string, unknown> = { link: "https://meet.google.com/abc-defg-hij" };
    cycle.self = cycle;
    expect(findMeetingLinks(cycle)).toHaveLength(1);
    class Event {
      link = "https://meet.google.com/abc-defg-hij";
    }
    expect(findMeetingLinks(new Event())).toEqual([]);
  });

  it("stops at a depth and a count limit", () => {
    let deep: unknown = "https://meet.google.com/abc-defg-hij";
    for (let n = 0; n < 50; n += 1) deep = [deep];
    expect(findMeetingLinks(deep)).toEqual([]);
    const many = Array.from(
      { length: 100 },
      (_, n) => `https://zoom.us/j/${String(81234567890 + n)}`,
    );
    expect(findMeetingLinks(many)).toHaveLength(20);
  });

  it("reads large input in linear time", () => {
    for (const input of [
      "https://".repeat(100_000),
      `${"https://zoom.us/j/".repeat(50_000)}.`,
      "&amp;".repeat(200_000),
      Array.from({ length: 4_000 }, () => "http://".repeat(200)),
    ]) {
      expectLinearTime(() => findMeetingLinks(input));
    }
  });

  it("does not read a link cut off by the text limit as a shorter meeting", () => {
    const filler = `${"x".repeat(999_972)} `;
    const cut = findMeetingLinks(`${filler}https://zoom.us/j/81234567890?pwd=abc`);
    expect(cut).toEqual([]);
    const whole = findMeetingLinks(`${filler.slice(0, 1_000)} https://zoom.us/j/81234567890`);
    expect(whole.map((link) => link.id)).toEqual(["81234567890"]);
  });

  it("reads an event's own fields before a long list inside it", () => {
    const event = {
      attendees: Array.from({ length: 6_000 }, () => ({ name: "Ann" })),
      location: "https://meet.google.com/abc-defg-hij",
    };
    expect(findMeetingLinks(event).map((link) => link.id)).toEqual(["abc-defg-hij"]);
  });

  it("does not walk a huge sparse array", () => {
    const sparse: unknown[] = [];
    sparse.length = 50_000_000;
    expect(findMeetingLinks(sparse)).toEqual([]);
  });

  it("does not run a getter that throws", () => {
    const event = {
      get broken(): string {
        throw new Error("boom");
      },
      note: "https://meet.google.com/abc-defg-hij",
    };
    expect(findMeetingLinks(event)).toHaveLength(1);
  });

  it("keeps the copy of a link that carries the passcode", () => {
    const text = "https://zoom.us/j/81234567890 https://zoom.us/j/81234567890?pwd=secret";
    expect(findMeetingLinks(text)).toEqual([
      { service: "zoom", id: "81234567890", url: "https://zoom.us/j/81234567890?pwd=secret" },
    ]);
  });

  it("reads a passcode after any spelling of an ampersand", () => {
    for (const amp of ["&amp;", "&#38;", "&#x26;"]) {
      const link = findMeetingLinks(`https://zoom.us/j/81234567890?from=x${amp}pwd=abc`);
      expect(link[0]?.url).toBe("https://zoom.us/j/81234567890?pwd=abc");
    }
  });
});

describe("findMeetingLinks edge cases", () => {
  it("keeps the passcode copy even when the other copy has the longer address", () => {
    const text = "https://zoom.us/j/81234567890?pwd=a https://us02web.zoom.us/j/81234567890";
    expect(findMeetingLinks(text)[0]?.url).toBe("https://zoom.us/j/81234567890?pwd=a");
    expect(findMeetingLinks(text.split(" ").reverse().join(" "))[0]?.url).toBe(
      "https://zoom.us/j/81234567890?pwd=a",
    );
  });

  it.each([
    "&lt;https://meet.google.com/abc-defg-hij&gt;",
    "&quot;https://meet.google.com/abc-defg-hij&quot;",
  ])("finds a link in escaped markup: %s", (text) => {
    expect(findMeetingLinks(text).map((link) => link.id)).toEqual(["abc-defg-hij"]);
  });

  it("skips a value that throws when inspected and reads the rest", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("no");
        },
      },
    );
    const event = [revoked.proxy, hostile, "https://meet.google.com/abc-defg-hij"];
    expect(findMeetingLinks(event).map((link) => link.id)).toEqual(["abc-defg-hij"]);
  });
});

describe("Teams meetup-join links", () => {
  const thread = "19%3ameeting_AbC%40thread.v2";

  it("gives differently encoded copies of one thread one id", () => {
    const lower = parseMeetingLink(`https://teams.microsoft.com/l/meetup-join/${thread}/0`);
    const upper = parseMeetingLink(
      "https://teams.microsoft.com/l/meetup-join/19%3Ameeting_AbC%40thread.v2/0",
    );
    const plain = parseMeetingLink(
      "https://teams.microsoft.com/l/meetup-join/19:meeting_AbC@thread.v2/0",
    );
    expect(lower?.id).toBe("19:meeting_AbC@thread.v2");
    expect(upper?.id).toBe(lower?.id);
    expect(plain?.id).toBe(lower?.id);
  });

  it.each(["x", "..%2f..%2fevil", "%E0%A4%A", "19%3ameeting_%40thread.v9"])(
    "rejects %s as a thread id",
    (segment) => {
      expect(parseMeetingLink(`https://teams.microsoft.com/l/meetup-join/${segment}/0`)).toBeNull();
    },
  );

  it("keeps a whole context and drops one that was cut off", () => {
    const context = encodeURIComponent('{"Tid":"t","Oid":"o"}');
    const base = `https://teams.microsoft.com/l/meetup-join/${thread}/0`;
    expect(parseMeetingLink(`${base}?context=${context}`)?.url).toBe(`${base}?context=${context}`);
    const raw = findMeetingLinks(`${base}?context={"Tid":"t","Oid":"o"}`);
    expect(raw[0]?.url).toBe(base);
  });
});
