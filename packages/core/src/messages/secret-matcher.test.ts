import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import { sanitizeModelConnectionError } from "../models/model-connection-error.js";
import {
  containsSecret,
  createStreamingRedactor,
  redactedRanges,
  redactSecrets,
  secretRedactor,
} from "./events.js";
import {
  cachedSecretMatcher,
  createIndexedMatcher,
  createSecretMatcher,
  indexedMatcherBuildCount,
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

  it("reuses one compiled matcher across fresh arrays with identical secrets", () => {
    const secrets = Array.from(
      { length: 500 },
      (_, index) => `shared-cache-secret-${index.toString().padStart(4, "0")}-abcdef123456`,
    );
    const target = secrets[250]!;
    const text = `${"plain text ".repeat(3_000)}${target} end`;
    const before = indexedMatcherBuildCount();

    const results = [
      secretRedactor([...secrets])(text),
      secretRedactor([...secrets].reverse())(text),
      secretRedactor([...secrets, "", secrets[0]!])(text),
      secretRedactor(new Set(secrets))(text),
      redactSecrets(text, [...secrets]),
      secretRedactor([...secrets])(text),
    ];
    for (const result of results) {
      expect(result).not.toContain(target);
      expect(result.endsWith("[redacted] end")).toBe(true);
    }
    expect(redactedRanges(text, [...secrets])).toEqual([
      [text.indexOf(target), text.indexOf(target) + target.length],
    ]);
    expect(containsSecret({ body: text }, [...secrets])).toBe(true);
    const stream = createStreamingRedactor([...secrets]);
    const streamed = stream.push(text) + stream.finish();
    expect(streamed).not.toContain(target);
    expect(streamed.endsWith("[redacted] end")).toBe(true);

    expect(indexedMatcherBuildCount() - before).toBe(1);
  });

  it("evicts least-recently-used sets at entry and char limits and bypasses oversized sets", () => {
    const live = ["live-initial-secret"];
    const snapshotRedact = secretRedactor(live);
    expect(snapshotRedact("live-initial-secret live-added-secret")).toBe(
      "[redacted] live-added-secret",
    );
    live.push("live-added-secret");
    expect(redactSecrets("live-initial-secret live-added-secret", live)).toBe(
      "[redacted] [redacted]",
    );
    expect(snapshotRedact("live-initial-secret live-added-secret")).toBe(
      "[redacted] live-added-secret",
    );

    // Exact entry-count limit (32 entries): 32nd entry keeps oldestSet resident; 33rd evicts oldest.
    const entrySets = Array.from({ length: 33 }, (_, index) => [
      `exact-entry-limit-secret-${index.toString().padStart(2, "0")}-xyz`,
    ]);
    const firstMatcher = cachedSecretMatcher([...entrySets[0]!]).matcher;
    const secondMatcher = cachedSecretMatcher([...entrySets[1]!]).matcher;
    for (let index = 2; index < 32; index += 1) {
      cachedSecretMatcher([...entrySets[index]!]);
    }
    // At exactly 32 resident entries, entrySets[0] is still cached (fails if limit were 31).
    expect(cachedSecretMatcher([...entrySets[0]!]).matcher).toBe(firstMatcher);
    // Touching entrySets[0] made entrySets[1] the oldest; adding the 33rd entry evicts entrySets[1].
    cachedSecretMatcher([...entrySets[32]!]);
    expect(cachedSecretMatcher([...entrySets[1]!]).matcher).not.toBe(secondMatcher);

    // WeakMap fast-path hit refreshes resident content LRU recency across 31 unrelated sets.
    const hotArray = ["weakmap-hot-secret-beta"];
    const hotMatcher = cachedSecretMatcher(hotArray).matcher;
    for (let index = 0; index < 32; index += 1) {
      expect(cachedSecretMatcher(hotArray).matcher).toBe(hotMatcher);
      cachedSecretMatcher([`unrelated-entry-set-${index}-xyz`]);
    }
    expect(cachedSecretMatcher([...hotArray]).matcher).toBe(hotMatcher);

    // Exact char-budget limit (2,000,000 chars total): retaining both 1,000,000-char halves fails
    // if the budget is 1,999,999; adding a 1-char set crosses 2,000,000 and evicts the oldest half.
    const halfA = ["a".repeat(1_000_000)];
    const halfB = ["b".repeat(1_000_000)];
    const halfAMatcher = cachedSecretMatcher([...halfA]).matcher;
    const halfBMatcher = cachedSecretMatcher([...halfB]).matcher;
    expect(cachedSecretMatcher([...halfA]).matcher).toBe(halfAMatcher);
    expect(cachedSecretMatcher([...halfB]).matcher).toBe(halfBMatcher);
    // halfA is now oldest (halfB was touched after halfA); a single char crosses 2,000,000.
    cachedSecretMatcher(["z"]);
    expect(cachedSecretMatcher([...halfB]).matcher).toBe(halfBMatcher);
    expect(cachedSecretMatcher([...halfA]).matcher).not.toBe(halfAMatcher);

    // Oversized set (> 2,000,000 chars) bypasses the content cache without evicting resident entries.
    const resident = ["resident-before-oversized-secret"];
    const residentMatcher = cachedSecretMatcher([...resident]).matcher;
    const oversized = ["o".repeat(2_000_001)];
    const oversizedFirst = cachedSecretMatcher([...oversized]).matcher;
    const oversizedSecond = cachedSecretMatcher([...oversized]).matcher;
    expect(oversizedSecond).not.toBe(oversizedFirst);
    expect(cachedSecretMatcher([...resident]).matcher).toBe(residentMatcher);

    // Put sentinels at the oldest positions of a full 32-entry cache so even ONE insertion by an
    // uncached diagnostic or validation path immediately evicts the oldest sentinel.
    const sentinels = Array.from({ length: 32 }, (_, index) => [
      `full-cache-sentinel-${index.toString().padStart(2, "0")}-xyz`,
    ]);
    const sentinelMatchers = sentinels.map((set) => cachedSecretMatcher([...set]).matcher);
    const diagSecret = "sk-ant-diag-transient-credential-998877";
    expect(
      sanitizeModelConnectionError(`Auth failed for ${diagSecret}`, [diagSecret]),
    ).not.toContain(diagSecret);
    expect(cachedSecretMatcher([...sentinels[0]!]).matcher).toBe(sentinelMatchers[0]);
    expect(containsSecret({ header: diagSecret }, [diagSecret], { cache: false })).toBe(true);
    expect(cachedSecretMatcher([...sentinels[1]!]).matcher).toBe(sentinelMatchers[1]);
    expect(redactSecrets(`leak ${diagSecret}`, [diagSecret], { cache: false })).toBe(
      "leak [redacted]",
    );
    expect(cachedSecretMatcher([...sentinels[2]!]).matcher).toBe(sentinelMatchers[2]);

    // Distinct secret sets stay isolated across eviction.
    const sets = Array.from({ length: 40 }, (_, index) => [`distinct-tenant-secret-${index}-xyz`]);
    for (let index = 0; index < sets.length; index += 1) {
      const own = sets[index]![0]!;
      const other = sets[(index + 1) % sets.length]![0]!;
      expect(redactSecrets(`${own} ${other}`, sets[index]!)).toBe(`[redacted] ${other}`);
    }

    // Mutating an empty result returned by redactedRanges on an indexed miss must not affect later calls.
    const missSecrets = Array.from({ length: 20 }, (_, index) => `miss-secret-${index}-abcdef`);
    const indexedMiss = redactedRanges("clean text without any match".repeat(200), missSecrets);
    expect(indexedMiss).toEqual([]);
    indexedMiss.push([0, 5]);
    expect(redactSecrets("clean text without any match", ["other-secret-value"])).toBe(
      "clean text without any match",
    );
    expect(redactedRanges("clean text without any match", missSecrets)).toEqual([]);
  });
});
