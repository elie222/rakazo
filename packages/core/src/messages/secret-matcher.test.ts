import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import { createStreamingRedactor, redactedRanges, redactSecrets } from "./events.js";
import { createIndexedMatcher, createSecretMatcher } from "./secret-matcher.js";

/** The per-value scan the matcher replaced, kept to check it finds the same stretches. */
function scannedRanges(value: string, secrets: string[]): Array<[number, number]> {
  const starts = new Int32Array(value.length + 1);
  const ends = new Int32Array(value.length + 1);
  for (const secret of secrets) {
    if (!secret) continue;
    for (let at = value.indexOf(secret); at !== -1; at = value.indexOf(secret, at + 1)) {
      starts[at] = starts[at]! + 1;
      ends[at + secret.length] = ends[at + secret.length]! + 1;
    }
  }
  const ranges: Array<[number, number]> = [];
  let open = 0;
  let start = 0;
  for (let offset = 0; offset <= value.length; offset += 1) {
    const ending = ends[offset]!;
    const starting = starts[offset]!;
    if (ending === 0 && starting === 0) continue;
    open -= ending;
    if (ending > 0 && open === 0) ranges.push([start, offset]);
    if (starting > 0 && open === 0) start = offset;
    open += starting;
  }
  return ranges;
}

/** A seeded generator (mulberry32), so a failure reproduces. */
function random(seed: number) {
  let state = seed;
  return (below: number) => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) % below;
  };
}

describe("createSecretMatcher", () => {
  it("finds the same stretches as scanning for each value", () => {
    // A small alphabet makes overlaps, repeats and touching matches common; the surrogate
    // halves check matching is by code unit, as indexOf is.
    const alphabet = ["a", "b", "c", "\uD83D", "\uDE00", "\n"];
    const next = random(42);
    const word = (max: number) =>
      Array.from({ length: 1 + next(max) }, () => alphabet[next(alphabet.length)]).join("");
    for (let round = 0; round < 2_000; round += 1) {
      const secrets = Array.from({ length: next(6) }, () => word(5));
      if (next(4) === 0) secrets.push("");
      const text = Array.from({ length: next(4) }, () => word(30)).join(secrets[0] ?? "");
      // The one-pass matcher, past a tiny state budget where it scans for each value instead,
      // and the matcher that picks between them.
      for (const matcher of [
        createIndexedMatcher(secrets),
        createIndexedMatcher(secrets, 3),
        createSecretMatcher(secrets),
      ]) {
        expect(matcher.ranges(text), JSON.stringify({ secrets, text })).toEqual(
          scannedRanges(text, secrets),
        );
        expect(matcher.test(text)).toBe(scannedRanges(text, secrets).length > 0);
      }
    }
  });

  it("merges overlapping matches and keeps touching ones apart", () => {
    const matcher = createIndexedMatcher(["abc", "cde", "xy", "y"]);
    expect(matcher.ranges("abcde xyxy")).toEqual([
      [0, 5],
      [6, 8],
      [8, 10],
    ]);
    expect(createIndexedMatcher(["bcdef", "ab", "a"]).ranges("abcdefg")).toEqual([[0, 6]]);
    expect(createSecretMatcher([]).ranges("anything")).toEqual([]);
    expect(createSecretMatcher(["", ""]).empty).toBe(true);
    expect(createIndexedMatcher(["", ""], 1).empty).toBe(true);
  });

  it("stays linear in the text with many values", () => {
    const next = random(7);
    const secrets = Array.from({ length: 5_000 }, () =>
      Array.from({ length: 40 }, () => String.fromCharCode(97 + next(26))).join(""),
    );
    const text = Array.from({ length: 2_000_000 }, () => String.fromCharCode(97 + next(26)))
      .join("")
      .concat(secrets[1_234]!);
    const nested = Array.from({ length: 2_000 }, (_, length) => "a".repeat(length + 1));
    expectLinearTime(() => {
      expect(redactedRanges(text, secrets)).toEqual([[2_000_000, 2_000_040]]);
      expect(redactSecrets("a".repeat(1_000_000), nested)).toBe("[redacted]");
    });
  });
});

describe("redacting with a growing list", () => {
  it("hides a value added to the same array after an earlier call", () => {
    const secrets = ["first-secret"];
    expect(redactSecrets("first-secret second-secret", secrets)).toBe("[redacted] second-secret");
    secrets.push("second-secret");
    expect(redactSecrets("first-secret second-secret", secrets)).toBe("[redacted] [redacted]");
    secrets[0] = "other";
    expect(redactSecrets("first-secret second-secret", secrets)).toBe("first-secret [redacted]");
  });

  it("streams with more values than one call takes as arguments", () => {
    const lines = Array.from({ length: 300_000 }, (_, index) => `line-${index}`.padEnd(16, "x"));
    const redactor = createStreamingRedactor([lines.join("\n")]);
    expect(redactor.push(`before ${lines[299_999]} after`) + redactor.finish()).toBe(
      "before [redacted] after",
    );
  });

  it("streams across chunks with one matcher", () => {
    const redactor = createStreamingRedactor(["hunter2-secret"]);
    expect(redactor.push("pass hunter2-") + redactor.push("secret done") + redactor.finish()).toBe(
      "pass [redacted] done",
    );
  });
});
