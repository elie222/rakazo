import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import type { MeetingLinkRecognizer } from "./meeting-links.js";
import { findMeetingLinks, meetingTokenParam, parseMeetingLink } from "./meeting-links.js";

/** A made-up service, so nothing here depends on a real one: `https://calls.example/j/<9 digits>`. */
const calls: MeetingLinkRecognizer = {
  id: "calls",
  recognize: ({ host, segments, query }) => {
    const [first, id] = segments;
    if (host !== "calls.example" || first !== "j" || segments.length !== 2) return undefined;
    if (!/^\d{9}$/.test(id ?? "")) return undefined;
    return {
      id: id!,
      params: { pwd: meetingTokenParam(query, "pwd"), room: meetingTokenParam(query, "room") },
    };
  },
};
const parse = (input: unknown) => parseMeetingLink(input, [calls]);
const find = (value: unknown) => findMeetingLinks(value, [calls]);
const link = (n: number, query = "") => `https://calls.example/j/${String(100000000 + n)}${query}`;
const FILLER = (length: number) => `${"x".repeat(length)} `;

describe("parseMeetingLink", () => {
  it("names the recognizer that read the link and keeps only what it asked for", () => {
    expect(parse(`${link(1)}?pwd=SeCrEt&from=addon&uname=Ann`)).toEqual({
      provider: "calls",
      id: "100000001",
      url: `${link(1)}?pwd=SeCrEt`,
    });
  });

  it("normalizes case, a trailing dot on the host, a trailing slash and the fragment", () => {
    expect(parse("  HTTPS://CALLS.EXAMPLE./j/100000001/#top  ")).toEqual({
      provider: "calls",
      id: "100000001",
      url: link(1),
    });
  });

  it.each([
    ["plain http", `http://calls.example/j/100000001`],
    ["another scheme", "javascript://calls.example/j/100000001"],
    ["a login on the real host", "https://user:pass@calls.example/j/100000001"],
    ["a login that names the service", "https://calls.example@evil.example/j/100000001"],
    ["a port", "https://calls.example:8443/j/100000001"],
    ["a look-alike host", "https://evilcalls.example/j/100000001"],
    ["a page that is not a meeting", "https://calls.example/pricing"],
  ])("rejects %s", (_name, input) => {
    expect(parse(input)).toBeNull();
  });

  it("returns null instead of throwing for input that is not a link", () => {
    for (const input of [undefined, null, "", "   ", 12, {}, [], "https://[", "not a url"]) {
      expect(parse(input)).toBeNull();
    }
  });

  it("reads nothing without a recognizer, and takes the first that reads the link", () => {
    expect(parseMeetingLink(link(1), [])).toBeNull();
    const other: MeetingLinkRecognizer = {
      id: "other",
      recognize: ({ segments }) => ({ id: segments.join("-"), params: {} }),
    };
    expect(parseMeetingLink(link(1), [calls, other])?.provider).toBe("calls");
    expect(parseMeetingLink(link(1), [other, calls])?.provider).toBe("other");
  });
});

describe("meetingTokenParam", () => {
  it("returns a bare token exactly, and nothing for a value that is anything else", () => {
    const query = (search: string) => new URLSearchParams(search);
    expect(meetingTokenParam(query("pwd=Ab_9-z"), "pwd")).toBe("Ab_9-z");
    for (const search of [
      "pwd=",
      "pwd=a!b",
      "pwd=a b",
      "pwd=a%2Bb",
      "other=x",
      `pwd=${"a".repeat(513)}`,
    ]) {
      expect(meetingTokenParam(query(search), "pwd")).toBeUndefined();
    }
  });
});

describe("findMeetingLinks", () => {
  it("finds links in text, markup and nested event fields, in order, once per meeting", () => {
    const event = {
      summary: "Planning",
      location: link(1),
      description: `Join <a href="${link(2, "?pwd=x&amp;from=addon")}">here</a> or ${link(1)}.`,
      attendees: [{ note: `Backup: ${link(3)})` }],
    };
    expect(find(event).map((found) => found.id)).toEqual(["100000001", "100000002", "100000003"]);
    expect(find(event)[1]?.url).toBe(link(2, "?pwd=x"));
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
      expect(find(value)).toEqual([]);
    }
  });

  it("ignores look-alike links next to a real one", () => {
    expect(
      find(`https://evilcalls.example/j/100000001 ${link(1)}`).map((found) => found.url),
    ).toEqual([link(1)]);
  });

  it("does not read class instances or loop on a cycle", () => {
    const cycle: Record<string, unknown> = { link: link(1) };
    cycle.self = cycle;
    expect(find(cycle)).toHaveLength(1);
    class Event {
      link = link(1);
    }
    expect(find(new Event())).toEqual([]);
  });

  it("stops at a depth limit", () => {
    let deep: unknown = link(1);
    for (let n = 0; n < 50; n += 1) deep = [deep];
    expect(find(deep)).toEqual([]);
  });

  it("returns at most 20 meetings", () => {
    const many = Array.from({ length: 100 }, (_, n) => link(n));
    expect(find(many).map((found) => found.id)).toEqual(
      many.slice(0, 20).map((url) => url.slice(-9)),
    );
  });

  it("still upgrades a known meeting to its passcode copy after the 20th distinct one", () => {
    const text = [
      ...Array.from({ length: 20 }, (_, n) => link(n)),
      link(21),
      link(2, "?pwd=secret"),
    ].join(" ");
    const found = find(text);
    expect(found).toHaveLength(20);
    expect(found.some((meeting) => meeting.id === "100000021")).toBe(false);
    expect(found[2]?.url).toBe(link(2, "?pwd=secret"));
  });

  it("reads large input in linear time", () => {
    for (const input of [
      "https://".repeat(100_000),
      `${"https://calls.example/j/".repeat(40_000)}.`,
      "&amp;".repeat(200_000),
      Array.from({ length: 4_000 }, () => "http://".repeat(200)),
    ]) {
      expectLinearTime(() => find(input));
    }
  });

  it("reads an event's own fields before a long list inside it", () => {
    const event = {
      attendees: Array.from({ length: 6_000 }, () => ({ name: "Ann" })),
      location: link(1),
    };
    expect(find(event).map((found) => found.id)).toEqual(["100000001"]);
  });

  it("does not walk a huge sparse array", () => {
    const sparse: unknown[] = [];
    sparse.length = 50_000_000;
    expect(find(sparse)).toEqual([]);
  });

  it("does not run a getter that throws", () => {
    const event = {
      get broken(): string {
        throw new Error("boom");
      },
      note: link(1),
    };
    expect(find(event)).toHaveLength(1);
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
    expect(find([revoked.proxy, hostile, link(1)]).map((found) => found.id)).toEqual(["100000001"]);
  });

  it("keeps the copy of a link that carries the passcode, whichever comes first", () => {
    const plain = link(1);
    const secret = link(1, "?pwd=secret");
    expect(find(`${plain} ${secret}`).map((found) => found.url)).toEqual([secret]);
    expect(find(`${secret} ${plain}`).map((found) => found.url)).toEqual([secret]);
  });

  it("keeps what two copies of one meeting each carry, whichever comes first", () => {
    const withRoom = link(1, "?room=a1");
    const withPasscode = link(1, "?pwd=secret");
    for (const text of [`${withRoom} ${withPasscode}`, `${withPasscode} ${withRoom}`]) {
      const urls = find(text).map((found) => found.url);
      expect(urls).toHaveLength(1);
      const kept = new URL(urls[0] ?? "");
      expect(kept.origin + kept.pathname).toBe(link(1));
      expect(Object.fromEntries(kept.searchParams)).toEqual({ pwd: "secret", room: "a1" });
    }
    expect(find(`${link(1, "?pwd=first")} ${link(1, "?pwd=second")}`)[0]?.url).toBe(
      link(1, "?pwd=first"),
    );
  });

  it("reads a meeting whose code is percent-encoded, and rejects an encoding that is not valid", () => {
    expect(parse("https://calls.example/j/10000000%31")?.id).toBe("100000001");
    expect(parse("https://calls.example/j/%E0%A4%A")).toBeNull();
    expect(parse("https://calls.example/j%2F100000001")).toBeNull();
  });

  it("reads a passcode after any spelling of an ampersand", () => {
    for (const amp of ["&amp;", "&#38;", "&#x26;"]) {
      expect(find(link(1, `?from=x${amp}pwd=abc`))[0]?.url).toBe(link(1, "?pwd=abc"));
    }
  });

  it.each([`&lt;${link(1)}&gt;`, `&quot;${link(1)}&quot;`])(
    "finds a link in escaped markup: %s",
    (text) => {
      expect(find(text).map((found) => found.id)).toEqual(["100000001"]);
    },
  );
});

describe("a passcode next to punctuation", () => {
  it("is returned exactly when the text around it is prose, and is never altered", () => {
    for (const tail of [".", ",", "!", "?", ")", "]", "*", ".)"]) {
      expect(find(`Join ${link(1, "?pwd=abc")}${tail}`)[0]?.url).toBe(link(1, "?pwd=abc"));
    }
  });

  it("is left out rather than guessed at when its value is not a bare token", () => {
    expect(find(link(1, "?pwd=a!b"))[0]?.url).toBe(link(1));
    expect(find(link(1, "?pwd=a%20b"))[0]?.url).toBe(link(1));
  });
});

describe("the text limit", () => {
  const link1 = link(1, "?pwd=abc");

  it("reads a link that straddles the limit to its end", () => {
    const found = find(`${FILLER(999_990)}${link1}`);
    expect(found.map((meeting) => meeting.url)).toEqual([link1]);
  });

  it("keeps a complete link whose trailing punctuation crosses the limit", () => {
    const found = find(`${FILLER(999_940)}${link1}${"!".repeat(5_000)}`);
    expect(found.map((meeting) => meeting.url)).toEqual([link1]);
  });

  it("leaves out a link that has no end within reach, never reading it short", () => {
    expect(find(`${FILLER(999_960)}${link(1, `?pwd=${"a".repeat(20_000)}`)}`)).toEqual([]);
    expect(find(`${FILLER(999_960)}${link(1, `?pwd=${"a".repeat(20_000)}`)} ${link(2)}`)).toEqual(
      [],
    );
  });

  it("does not read a link that starts after the limit because punctuation joins it to the text", () => {
    expect(find(`${FILLER(999_990)}${"x".repeat(9)}.${link(1)}`)).toEqual([]);
    expect(find(`${FILLER(999_990)}${"x".repeat(9)}.${link(1)} ${link(2)}`)).toEqual([]);
  });

  it("applies the limit to a link that an escaped quote joins to earlier text", () => {
    const before = `${FILLER(999_980)}https://a.example/`;
    expect(find(`${before}&quot;${link(1)}`)).toEqual([]);
    expect(find(`${before}"${link(1)}`)).toEqual([]);
  });

  it("counts the limit in decoded characters, so entities do not hide a link inside it", () => {
    const meeting = ` ${link(1)} `;
    expect(find(`${"&amp;".repeat(250_000)}${meeting}`).map((found) => found.id)).toEqual([
      "100000001",
    ]);
    expect(
      find([FILLER(1_000_000 - 2_100), `${"&amp;".repeat(2_060)}${meeting}`]).map(
        (found) => found.id,
      ),
    ).toEqual(["100000001"]);
    const long = `${link(1)}?x=${"&amp;".repeat(2_100)}`;
    expect(find(`${FILLER(999_989)}${long} tail`).map((found) => found.id)).toEqual(["100000001"]);
  });

  it("spends the whole budget on a string the limit cuts, so many of them stay linear", () => {
    const huge = `https://a${"b".repeat(1_100_000)}`;
    expect(find([huge, link(2)])).toEqual([]);
    expectLinearTime(() => find([...Array.from({ length: 300 }, () => huge), link(2)]));
  });

  it("reads links before the limit and ignores text after it", () => {
    expect(find(`${link(2)} ${FILLER(1_000_100)}${link(3)}`).map((meeting) => meeting.id)).toEqual([
      "100000002",
    ]);
  });
});
