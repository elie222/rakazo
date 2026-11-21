import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { matchesSearchQuery } from "@rakazo/core";
import {
  prefixQueryTokenSets,
  querySearchTokens,
  searchTerms,
  searchTokens,
  wordAndPrefixTokens,
} from "../src/encryption/content-crypto.ts";
import { messages, queries } from "./zh-search-fixtures.ts";

const key = { key: Buffer.alloc(32, 1), id: "test", version: 1, spaceId: "test" };

function indexes(text: string) {
  const strings = ["text", text];
  return {
    legacy: wordAndPrefixTokens(key, text, searchTerms(strings.join("\n"))),
    current: searchTokens(key, { words: text, strings }, "han-pairs"),
  };
}

function accepts(groups: number[][], stored: number[]) {
  return groups.some((group) => group.every((token) => stored.includes(token)));
}

function verifyCompatibility() {
  // These inputs reproduce the original compatibility run, including the order of the draws.
  let state = 0x62c442da;
  function random(limit: number) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  }
  const alphabet = ["A", "X", "中", "海", "𠮷", "2", " ", "。", "ß", "Ａ"];
  const digest = createHash("sha256");
  let lookups = 0;
  let indexMatches = 0;
  let shortQueries = 0;
  for (let i = 0; i < 400; i++) {
    const chars = Array.from({ length: random(37) + 5 }, () => alphabet[random(alphabet.length)]!);
    const { legacy, current } = indexes(chars.join(""));
    digest.update(`${JSON.stringify(legacy)}\n`);
    for (let j = 0; j < 22; j++) {
      const start = random(chars.length);
      const query = chars
        .slice(start, start + 1 + random(20))
        .join("")
        .trim();
      if (!query) continue;
      lookups++;
      const before = querySearchTokens(key, query, "prefix");
      digest.update(`${JSON.stringify(before)}\n`);
      if (!before.every((token) => legacy.includes(token))) continue;
      const after = prefixQueryTokenSets(key, query);
      if (before.length) {
        indexMatches++;
        assert(
          accepts(after.legacy, legacy),
          `Lost an old index match in message ${i}, query ${j}`,
        );
        assert(
          accepts(after.legacy, current),
          `Lost a rewritten index match in message ${i}, query ${j}`,
        );
      } else {
        shortQueries++;
        assert.deepEqual(
          after,
          { legacy: [[]], exact: [], compact: [] },
          "Short queries must still use the bounded fallback scan",
        );
      }
    }
  }
  // Digest of the stored arrays and query arrays from the original prefix-only implementation.
  // This guards against changing the baseline and the reader together.
  assert.equal(
    digest.digest("hex"),
    "5c1d7920fcc05861ac207ef713b1fb178dd3d62644881e8255127c7b66ec2138",
  );
  process.stdout.write(
    `Legacy compatibility: ${lookups} nonempty lookups in 400 messages, ${indexMatches} index matches preserved on both formats, ${shortQueries} bounded-scan queries preserved.\n`,
  );
}

const corpus = messages.map((message) => ({ ...message, ...indexes(message.text) }));
if (process.argv[2] === "--storage-tsv") {
  for (const row of corpus) {
    process.stdout.write(`production\t${row.id}\t{${row.current.join(",")}}\n`);
  }
} else {
  verifyCompatibility();
  let hits = 0;
  let expectedHits = 0;
  let scanHits = 0;
  for (const query of queries) {
    const { legacy, exact, compact } = prefixQueryTokenSets(key, query.text);
    const groups = [...legacy, ...exact, ...compact];
    const found = corpus.filter(
      (row) => accepts(groups, row.current) && matchesSearchQuery(query.text, row.text),
    );
    assert.deepEqual(
      found.map((row) => row.id),
      query.text === "sql16" ? [] : query.expected,
    );
    hits += found.length;
    expectedHits += query.expected.length;
    if (groups.every((group) => group.length === 0)) scanHits += found.length;
  }
  const count = corpus.reduce((sum, row) => sum + row.current.length, 0);
  process.stdout.write(
    `Production reader/writer: ${hits}/${expectedHits} fixture matches (${scanHits} from the bounded scan), ${count} stored tokens.\n`,
  );
  // A continuous Han run with many distinct pairs and a query only at its tail.
  for (const length of [200, 500, 100_000]) {
    const start = Array.from({ length: length - 2 }, (_, i) =>
      String.fromCodePoint(0x4e00 + (i % 12_000)),
    ).join("");
    const { current, legacy } = indexes(`${start}鲸落`);
    const { exact, compact } = prefixQueryTokenSets(key, "鲸落");
    assert(accepts([...exact, ...compact], current));
    process.stdout.write(
      `Han run of ${length} characters: ${current.length} stored tokens (legacy ${legacy.length}), tail found by ${accepts(exact, current) ? "exact" : "compact"} index.\n`,
    );
  }
}
