import assert from "node:assert/strict";
import { matchesSearchQuery } from "@rakazo/core";
import {
  querySearchTokens,
  searchTerms,
  wordAndPrefixTokens,
} from "../src/encryption/content-crypto.ts";
import { messages, queries } from "./zh-search-fixtures.ts";

const methods = ["prefix", "segmenter", "bigram"] as const;
type Method = (typeof methods)[number];
const labels = { prefix: "现有前缀", segmenter: "中文分词", bigram: "相邻双字" };
const key = { id: "test-key", spaceId: "test-space", version: 1, key: Buffer.alloc(32, 1) };
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

// Change the input to the prefix domain only. Production still handles normalization,
// prefix lengths, HMAC domains, per-message deduplication and query token generation.
function prefixInputs(text: string, method: Method): string[] {
  if (method === "prefix") return [text];
  return searchTerms(text).flatMap((term) =>
    term.split(/(\p{Script=Han}+)/u).flatMap((run) => {
      if (!run) return [];
      if (!/^\p{Script=Han}/u.test(run)) return [run];
      if (method === "segmenter") return Array.from(segmenter.segment(run), (part) => part.segment);
      const chars = Array.from(run);
      return chars.slice(1).map((next, i) => chars[i] + next);
    }),
  );
}

// One {kind: "text", text} block per message, in fixture order from oldest to newest.
const indexes = methods.map((method) =>
  messages.map(({ id, text }) => ({
    id,
    text,
    tokens: wordAndPrefixTokens(
      key,
      text,
      searchTerms(["text", ...prefixInputs(text, method)].join("\n")),
    ),
  })),
);

function runQueries(method: Method, index: (typeof indexes)[number]) {
  return queries.map(({ text, expected }) => {
    const truth = messages.filter((message) => matchesSearchQuery(text, message.text));
    assert.deepEqual(
      truth.map(({ id }) => id),
      expected,
      `Unexpected labels: ${text}`,
    );
    const tokens = querySearchTokens(key, prefixInputs(text, method).join(" "), "prefix");
    const scan = tokens.length === 0;
    // All fixtures fit in the API's first candidate page and below its 25-result cap.
    // With no indexable term, the API checks at most 200 recent encrypted messages.
    const candidates = scan
      ? index.slice(-200)
      : index.filter((row) => tokens.every((token) => row.tokens.includes(token)));
    const hits = candidates
      .filter((row) => matchesSearchQuery(text, row.text))
      .map((row) => row.id);
    return { scan, checked: candidates.length, hits };
  });
}

function report(): string {
  const results = methods.map((method, i) => runQueries(method, indexes[i]!));
  const relevant = queries.reduce((sum, query) => sum + query.expected.length, 0);
  const lines = [
    `Node ${process.versions.node} · ICU ${process.versions.icu} · ${messages.length} 条消息 · ${queries.length} 个查询 · ${relevant} 个应命中的查询–消息对。`,
    "",
    "| 方案 | 最终召回 | 索引命中 | 索引候选 | 扫描命中 | 回退查询数 | 扫描候选 | 标记数 | 标记载荷（字节） |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [i, method] of methods.entries()) {
    const rows = results[i]!;
    const indexed = rows.filter((row) => !row.scan);
    const scans = rows.filter((row) => row.scan);
    const indexedHits = indexed.reduce((sum, row) => sum + row.hits.length, 0);
    const scanHits = scans.reduce((sum, row) => sum + row.hits.length, 0);
    const checked = (subset: typeof rows) => subset.reduce((sum, row) => sum + row.checked, 0);
    const count = indexes[i]!.reduce((sum, row) => sum + row.tokens.length, 0);
    lines.push(
      `| ${labels[method]} | ${indexedHits + scanHits}/${relevant} | ${indexedHits} | ${checked(indexed)} | ${scanHits} | ${scans.length} | ${checked(scans)} | ${count} | ${count * 4} |`,
    );
  }
  lines.push(
    "",
    "### 逐条查询",
    "",
    "单元格列出原文复核通过的消息。扫表示该查询通过最近消息扫描取得结果。空集用 ∅ 表示。",
    "",
    "| 查询 | 应命中 | 现有前缀 | 中文分词 | 相邻双字 |",
    "| --- | --- | --- | --- | --- |",
  );
  const ids = (values: string[]) => values.join("、") || "∅";
  for (const [i, query] of queries.entries()) {
    const cells = results.map((rows) => {
      const row = rows[i]!;
      return ids(row.hits) + (row.scan ? "（扫）" : "");
    });
    lines.push(`| ${query.text} | ${ids(query.expected)} | ${cells.join(" | ")} |`);
  }
  lines.push("", "### 样本消息", "", "| ID | 正文 |", "| --- | --- |");
  for (const { id, text } of messages) lines.push(`| ${id} | ${text} |`);
  return lines.join("\n");
}

if (process.argv[2] === "--storage-tsv") {
  for (const [i, method] of methods.entries()) {
    for (const { id, tokens } of indexes[i]!)
      process.stdout.write(`${method}\t${id}\t{${tokens.join(",")}}\n`);
  }
  // Preserve the initial same-domain dual-write measurement independently of
  // the production encoding, whose domains reserve the legacy candidate window.
  for (const [i, row] of indexes[0]!.entries()) {
    const tokens = [...new Set([...row.tokens, ...indexes[2]![i]!.tokens])].sort((a, b) => a - b);
    process.stdout.write(`dual-write\t${row.id}\t{${tokens.join(",")}}\n`);
  }
} else {
  process.stdout.write(`${report()}\n`);
}
