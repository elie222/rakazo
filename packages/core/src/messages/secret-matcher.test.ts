import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import {
  createStreamingRedactor,
  redactedRanges,
  redactSecrets,
  sanitizeUtf16ForJson,
} from "./events.js";
import {
  createIndexedMatcher,
  createSecretMatcher,
  indexedMatcherBuildCount,
  kmpTableBuildCount,
} from "./secret-matcher.js";

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

  it("streams small deltas in linear time regardless of longest secret length", () => {
    const longBody = Array.from(
      { length: 800 },
      (_, index) =>
        `PemLine${index.toString().padStart(4, "0")}${"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/".slice(0, 52)}`,
    ).join("\n");
    const pemSecret = `-----BEGIN FAKE KEY-----\n${longBody}\n-----END FAKE KEY-----`;
    const shortSecrets = Array.from(
      { length: 30 },
      (_, index) => `stream-short-secret-${index}-value`,
    );
    const singleLongSecret = `LONG_SECRET_${"k".repeat(50_000)}_END`;
    const deltas = Array.from({ length: 10_000 }, (_, index) => `d${index % 100} `);

    expectLinearTime(() => {
      // Multi-secret + long PEM key (exercises indexed Aho-Corasick streaming).
      const multi = createStreamingRedactor([...shortSecrets, pemSecret]);
      let multiOut = "";
      for (const delta of deltas) multiOut += multi.push(delta);
      multiOut += multi.push(shortSecrets[5]!.slice(0, 10));
      multiOut += multi.push(shortSecrets[5]!.slice(10));
      multiOut += multi.finish();
      expect(multiOut.endsWith("[redacted]")).toBe(true);
      expect(multiOut).not.toContain(shortSecrets[5]);

      // Single very long secret (stays below BUILD_COST, exercises incremental KMP streaming).
      const single = createStreamingRedactor([singleLongSecret]);
      let singleOut = "";
      for (const delta of deltas) singleOut += single.push(delta);
      singleOut += single.push(singleLongSecret.slice(0, 25_000));
      singleOut += single.push(singleLongSecret.slice(25_000));
      singleOut += single.finish();
      expect(singleOut.endsWith("[redacted]")).toBe(true);
      expect(singleOut).not.toContain(singleLongSecret);

      // Long active prefix held across many 1-char deltas plus many short matches inside the
      // active prefix: stays linear without flattening the hold buffer or splicing pendingRanges.
      const repeatedLong = `${"a".repeat(50_000)}X`;
      const longPrefixKmp = createStreamingRedactor([repeatedLong, "ab"]);
      let kmpPrefixOut = longPrefixKmp.push("a".repeat(50_000));
      for (let index = 0; index < 10_000; index += 1) {
        kmpPrefixOut += longPrefixKmp.push("a");
      }
      kmpPrefixOut += longPrefixKmp.push("X");
      kmpPrefixOut += longPrefixKmp.finish();
      expect(kmpPrefixOut).toBe(`${"a".repeat(10_000)}[redacted]`);

      const repeatedWithShorts = [
        `${"ab".repeat(25_000)}Z`,
        "ab",
        ...Array.from({ length: 10 }, (_, index) => `pad-indexed-secret-${index}`),
      ];
      const indexedBuildsBefore = indexedMatcherBuildCount();
      const longPrefixIndexed = createStreamingRedactor(repeatedWithShorts);
      let indexedPrefixOut = longPrefixIndexed.push("ab".repeat(25_000));
      for (let index = 0; index < 5_000; index += 1) {
        indexedPrefixOut += longPrefixIndexed.push("a");
        indexedPrefixOut += longPrefixIndexed.push("b");
      }
      indexedPrefixOut += longPrefixIndexed.push("Z");
      indexedPrefixOut += longPrefixIndexed.finish();
      expect(indexedMatcherBuildCount()).toBeGreaterThan(indexedBuildsBefore);
      expect(indexedPrefixOut).toBe("[redacted]".repeat(5_001));
    });
  });

  it("shares lazily built KMP tables across streams using one cached matcher", () => {
    const longSecret = `kmp-shared-table-${"q".repeat(50_000)}-end`;
    const secrets = [longSecret];
    const before = kmpTableBuildCount();
    for (let index = 0; index < 64; index += 1) {
      const redactor = createStreamingRedactor(secrets);
      const out = redactor.push(longSecret.slice(0, 3)) + redactor.finish();
      expect(out).toBe("kmp");
    }
    expect(kmpTableBuildCount() - before).toBe(1);
  });

  it("matches full-string redaction across arbitrary splits, overlaps, empty deltas, and mid-stream secret additions", () => {
    // Prefix-sharing and bridging secrets split one code unit at a time.
    for (const [secrets, samples] of [
      [
        ["abcdef", "cd"],
        ["abcdef", "abcdxx", "xxabcdefyy", "cdabcdefcd"],
      ],
      [
        ["abc", "def", "cdefg"],
        ["abcdefg", "abcdefx", "abcdefgdef", "abccdefg"],
      ],
      [
        ["ab", "bcde", "efg", "cd"],
        ["abcdefg", "abcdex", "abefg", "abxcd"],
      ],
    ] as const) {
      for (const sample of samples) {
        const redactor = createStreamingRedactor([...secrets]);
        let out = redactor.push("");
        for (let index = 0; index < sample.length; index += 1) {
          out += redactor.push(sample[index]!);
          if (index % 2 === 0) out += redactor.push("");
        }
        out += redactor.finish();
        expect(out, JSON.stringify({ secrets, sample })).toBe(
          sanitizeUtf16ForJson(redactSecrets(sample, secrets)),
        );
      }
    }

    // Randomized equivalence against full-string redaction with small alphabet + surrogates.
    const alphabet = ["a", "b", "c", "\uD83D", "\uDE00", "\n"];
    const next = random(1337);
    const word = (max: number) =>
      Array.from({ length: 1 + next(max) }, () => alphabet[next(alphabet.length)]).join("");
    for (let round = 0; round < 500; round += 1) {
      const secrets = Array.from({ length: next(6) }, () => word(6));
      if (next(4) === 0) secrets.push("");
      const text = Array.from({ length: next(5) }, () => word(25)).join(secrets[0] ?? "");
      const redactor = createStreamingRedactor(secrets);
      let out = "";
      let at = 0;
      while (at < text.length) {
        const size = next(5); // includes 0 for empty deltas
        out += redactor.push(text.slice(at, at + size));
        at += size;
      }
      out += redactor.finish();
      expect(out, JSON.stringify({ round, secrets, text })).toBe(
        sanitizeUtf16ForJson(redactSecrets(text, secrets)),
      );
    }

    // Live secrets array growing mid-stream: held prefix rescans with the new secret.
    const live = ["shared-prefix-old-secret"];
    const liveRedactor = createStreamingRedactor(live);
    const first = liveRedactor.push("ok shared-prefix-");
    expect(first).toBe("ok ");
    live.push("shared-prefix-new-secret");
    const rest = liveRedactor.push("new-secret done") + liveRedactor.finish();
    expect(first + rest).toBe("ok [redacted] done");

    // Registration boundary: a prefix already emitted before registration cannot be un-emitted,
    // while matches starting in or after registration are redacted.
    const boundarySecrets = ["unrelated-secret"];
    const boundaryRedactor = createStreamingRedactor(boundarySecrets);
    expect(boundaryRedactor.push("new-")).toBe("new-");
    boundarySecrets.push("new-secret");
    expect(boundaryRedactor.push("secret! new-secret") + boundaryRedactor.finish()).toBe(
      "secret! [redacted]",
    );

    // Live secrets array starting empty and gaining a secret mid-stream.
    const initiallyEmpty: string[] = [];
    const lateRedactor = createStreamingRedactor(initiallyEmpty);
    expect(lateRedactor.push("before ")).toBe("before ");
    initiallyEmpty.push("late-added-secret");
    expect(
      lateRedactor.push("late-added-") + lateRedactor.push("secret after") + lateRedactor.finish(),
    ).toBe("[redacted] after");

    // Crossing BUILD_COST right in the middle of a split secret preserves match state during KMP -> indexed upgrade.
    const upgradeSecrets = Array.from(
      { length: 20 },
      (_, index) => `upgrade-secret-${index.toString().padStart(2, "0")}-xyz`,
    );
    const upgradeTarget = upgradeSecrets[7]!;
    const upgradeText = `${"p".repeat(155)}${upgradeTarget} tail`;
    const upgradeRedactor = createStreamingRedactor(upgradeSecrets);
    let upgradeOut = "";
    for (let at = 0; at < upgradeText.length; at += 3) {
      upgradeOut += upgradeRedactor.push(upgradeText.slice(at, at + 3));
    }
    upgradeOut += upgradeRedactor.finish();
    expect(upgradeOut).toBe(`${"p".repeat(155)}[redacted] tail`);
  });
});
