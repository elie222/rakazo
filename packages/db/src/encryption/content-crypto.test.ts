import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DataKey } from "./content-crypto.js";
import {
  artifactKeyId,
  ContentDecryptionError,
  ciphertextKeyId,
  decryptText,
  encryptText,
  isSealedArtifact,
  jsonKeyIds,
  jsonNeedsSealing,
  openArtifact,
  openJson,
  prefixQueryTokenSets,
  querySearchTokens,
  sealArtifact,
  sealJson,
  searchTokens,
} from "./content-crypto.js";

const key: DataKey = { id: "key-1", spaceId: "space-1", version: 1, key: randomBytes(32) };
const location = { table: "messages", column: "blocks", rowId: "row-1", owner: "thread-1" };

async function* from(...chunks: Uint8Array[]) {
  yield* chunks;
}
async function collect(source: AsyncIterable<Uint8Array>) {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

describe("content ciphertext", () => {
  it("round-trips with a fresh IV and names its key", () => {
    const first = encryptText(key, location, "hello");
    const second = encryptText(key, location, "hello");
    expect(first).not.toBe(second);
    expect(first.startsWith("rkz1:key-1:")).toBe(true);
    expect(ciphertextKeyId(first)).toBe("key-1");
    expect(decryptText(key, location, first)).toBe("hello");
  });

  it("fails authentication when moved to another table, column, row or space", () => {
    const sealed = encryptText(key, location, "hello");
    for (const moved of [
      { ...location, table: "events" },
      { ...location, column: "payload" },
      { ...location, rowId: "row-2" },
      { ...location, owner: "thread-2" },
    ])
      expect(() => decryptText(key, moved, sealed)).toThrow(ContentDecryptionError);
    expect(() => decryptText({ ...key, spaceId: "space-2" }, location, sealed)).toThrow(
      ContentDecryptionError,
    );
  });

  it("detects tampering and wrong keys", () => {
    const sealed = encryptText(key, location, "hello");
    const flipped = `${sealed.slice(0, -2)}${sealed.at(-2) === "A" ? "B" : "A"}${sealed.at(-1)}`;
    expect(() => decryptText(key, location, flipped)).toThrow(ContentDecryptionError);
    expect(() => decryptText({ ...key, key: randomBytes(32) }, location, sealed)).toThrow(
      ContentDecryptionError,
    );
    expect(() => decryptText({ ...key, id: "key-2" }, location, sealed)).toThrow(
      ContentDecryptionError,
    );
  });

  it("seals JSON per element and keeps plain keys queryable", () => {
    const blocks = [
      { kind: "text", text: "secret" },
      { kind: "channel_message", channelId: "c1", text: "also secret", hop: 2 },
    ];
    const sealed = sealJson(blocks, new Set(["kind", "channelId"]), (plaintext) =>
      encryptText(key, location, plaintext),
    ) as Array<Record<string, unknown>>;
    expect(JSON.stringify(sealed)).not.toContain("secret");
    expect(sealed[1]).toMatchObject({ kind: "channel_message", channelId: "c1" });
    expect(sealed[1]).not.toHaveProperty("hop");
    expect(jsonKeyIds(sealed)).toEqual(["key-1", "key-1"]);
    expect(jsonNeedsSealing(sealed)).toBe(false);
    expect(jsonNeedsSealing(blocks)).toBe(true);
    expect(jsonNeedsSealing([])).toBe(false);
    expect(openJson(sealed, (value) => decryptText(key, location, value))).toEqual(blocks);
  });

  it("reads plaintext JSON unchanged", () => {
    const payload = { messageId: "m1", $sealed: "not ciphertext" };
    expect(openJson(payload, () => "unused")).toBe(payload);
    expect(jsonKeyIds(payload)).toEqual([]);
  });

  it("reports malformed decrypted JSON as a syntax error without quoting the value", () => {
    const sealed = { $sealed: encryptText(key, location, "private invalid JSON fixture") };
    const read = () => openJson(sealed, (value) => decryptText(key, location, value));
    expect(read).toThrow(SyntaxError);
    expect(read).toThrow(/^Invalid encrypted JSON$/);
  });
});

describe("blind index tokens", () => {
  const indexKey = { ...key, key: Buffer.alloc(32, 1) };

  it("matches words and prefixes without revealing them, per key", () => {
    const tokens = new Set(
      searchTokens(key, { words: "Ship the Pelican report", strings: ["Ship the Pelican report"] }),
    );
    for (const token of querySearchTokens(key, "pelican SHIP", "word"))
      expect(tokens.has(token)).toBe(true);
    for (const token of querySearchTokens(key, "peli rep", "prefix"))
      expect(tokens.has(token)).toBe(true);
    expect(querySearchTokens(key, "elican", "prefix").every((token) => tokens.has(token))).toBe(
      false,
    );
    expect(querySearchTokens(key, "x", "prefix")).toEqual([]);
    const other = querySearchTokens({ ...key, key: randomBytes(32) }, "pelican", "word");
    expect(tokens.has(other[0]!)).toBe(false);
  });

  it("only indexes history text as words", () => {
    const tokens = new Set(searchTokens(key, { words: "", strings: ["photo.png"] }));
    expect(tokens.has(querySearchTokens(key, "photo", "word")[0]!)).toBe(false);
    expect(tokens.has(querySearchTokens(key, "photo", "prefix")[0]!)).toBe(true);
  });

  it("keeps the public two-argument encoder compatible with the original prefix query", () => {
    const text = "我们今天讨论部署方案";
    const input = { words: text, strings: [text] };
    const original = searchTokens(indexKey, input);
    expect(original).toEqual(searchTokens(indexKey, input, "prefix"));
    expect(original).toEqual(
      expect.arrayContaining(querySearchTokens(indexKey, "我们今天", "prefix")),
    );
    expect(original).not.toContain(querySearchTokens(indexKey, "部署", "prefix")[0]);
    const english = { words: "build", strings: ["build"] };
    expect(searchTokens(indexKey, english, "han-pairs")).toEqual(searchTokens(indexKey, english));
  });

  it("indexes overlapping Han pairs inside text, including supplementary characters", () => {
    const text = "我们今天讨论部署方案，明晚去𠮷野。";
    const stored = searchTokens(indexKey, { words: text, strings: ["text", text] }, "han-pairs");
    for (const pair of ["论部", "部署", "署方", "方案", "去𠮷", "𠮷野"]) {
      const [tokens] = prefixQueryTokenSets(indexKey, pair).exact;
      expect(tokens).toBeDefined();
      expect(stored).toEqual(expect.arrayContaining(tokens!));
    }
    expect(stored).toEqual(
      expect.arrayContaining(querySearchTokens(indexKey, "我们今天讨论部署方案", "word")),
    );
    expect(stored).not.toContain(querySearchTokens(indexKey, "部署", "word")[0]);
  });

  it("indexes English prefixes and Han pairs on either side of script boundaries", () => {
    const text = "今晚部署API服务，先升级PostgreSQL16再重启。";
    const stored = searchTokens(indexKey, { words: text, strings: ["text", text] }, "han-pairs");
    for (const query of ["部署", "ap", "API", "服务", "postgre", "重启"]) {
      const [tokens] = prefixQueryTokenSets(indexKey, query).exact;
      expect(tokens).toBeDefined();
      expect(stored).toEqual(expect.arrayContaining(tokens!));
    }
    const { exact } = prefixQueryTokenSets(indexKey, "sql16");
    expect(stored).not.toContain(exact[0]![0]);
  });

  it("indexes adjacent Han and non-Han code points in both directions under the same pair budget", () => {
    const start = Array.from(
      { length: 300 },
      (_, i) => `${String.fromCodePoint(0x4e00 + i)}7`,
    ).join("");
    const tail = "部署API服务９𠮷Ｂ";
    for (const [text, format] of [
      [tail, "exact"],
      [start + tail, "compact"],
    ] as const) {
      const input = { words: text, strings: [text] };
      const stored = searchTokens(indexKey, input, "han-pairs");
      expect(stored.length).toBeLessThanOrEqual(searchTokens(indexKey, input).length + 251 + 2);
      for (const query of ["署A", "署ap", "i服", "PI服务", "务９", "9𠮷", "𠮷b"]) {
        const groups = prefixQueryTokenSets(indexKey, query)[format];
        expect(
          groups.some((group) => group.every((token) => stored.includes(token))),
          query,
        ).toBe(true);
      }
    }
  });

  it("requires all indexable pieces of a mixed query in the same message", () => {
    const texts = [
      "请看今晚部署方案API服务的日志",
      "今晚部署方案改由Web服务处理",
      "今晚部署时间由API服务决定",
    ];
    const { legacy, exact, compact } = prefixQueryTokenSets(indexKey, "部署方案api服务");
    const alternatives = [...legacy, ...exact, ...compact];
    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives.every((tokens) => tokens.length > 0)).toBe(true);
    const hits = texts.filter((text) => {
      const stored = searchTokens(indexKey, { words: text, strings: ["text", text] }, "han-pairs");
      return alternatives.some((tokens) => tokens.every((token) => stored.includes(token)));
    });
    expect(hits).toEqual([texts[0]]);
    expect(prefixQueryTokenSets(indexKey, "部")).toEqual({ legacy: [[]], exact: [], compact: [] });
  });

  it("can still find a mixed word prefix made of individually unindexable pieces", () => {
    const text = "版A中B已就绪";
    const stored = searchTokens(indexKey, { words: text, strings: ["text", text] }, "han-pairs");
    const { legacy: alternatives } = prefixQueryTokenSets(indexKey, "版A中B");
    expect(
      alternatives.some(
        (tokens) => tokens.length > 0 && tokens.every((token) => stored.includes(token)),
      ),
    ).toBe(true);
  });

  it("bounds Han-pair tokens across the message and keeps matches beyond the budget", () => {
    const body = Array.from({ length: 12_000 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join(
      "",
    );
    const strings = [body.slice(0, 6_000), `${body.slice(6_000)}𠮷野CDN`];
    const oldIndex = searchTokens(indexKey, { words: "", strings }, "prefix");
    const stored = searchTokens(indexKey, { words: "", strings }, "han-pairs");
    // At most 251 compact Han tokens beyond the old two-word index and two CDN prefixes.
    expect(stored.length).toBeLessThanOrEqual(oldIndex.length + 251 + 2);
    for (const length of [120, 800]) {
      const tail = prefixQueryTokenSets(indexKey, `${body.slice(-length)}𠮷野cdn`);
      expect(tail.exact.some((set) => set.every((token) => stored.includes(token)))).toBe(false);
      expect(tail.compact.some((set) => set.every((token) => stored.includes(token)))).toBe(true);
    }
    const wrongSuffix = prefixQueryTokenSets(indexKey, "𠮷野XYZ");
    expect(wrongSuffix.compact.some((set) => set.every((token) => stored.includes(token)))).toBe(
      false,
    );
    // A formerly searchable word prefix still uses its original budget after a rewrite.
    const head = prefixQueryTokenSets(indexKey, body.slice(0, 30));
    for (const index of [oldIndex, stored])
      expect(head.legacy.some((set) => set.every((token) => index.includes(token)))).toBe(true);
  });
});

describe("artifact stream", () => {
  for (const size of [0, 1, 64 * 1024 - 1, 64 * 1024, 64 * 1024 * 2, 200_001]) {
    it(`round-trips ${size} bytes`, async () => {
      const bytes = randomBytes(size);
      const sealed = await collect(
        sealArtifact(key, "file-1", from(bytes.subarray(0, 7), bytes.subarray(7))),
      );
      expect(isSealedArtifact(sealed)).toBe(true);
      expect(artifactKeyId(sealed)).toBe("key-1");
      if (size > 32) expect(sealed.includes(bytes.subarray(0, 32))).toBe(false);
      // Odd-sized reads split the header and segments across chunk boundaries.
      const pieces: Buffer[] = [];
      for (let offset = 0; offset < sealed.length; offset += 9_973)
        pieces.push(sealed.subarray(offset, offset + 9_973));
      pieces.unshift(sealed.subarray(0, 0));
      const opened = await collect(openArtifact(async () => key, "file-1", from(...pieces)));
      expect(opened.equals(bytes)).toBe(true);
    });
  }

  it("rejects truncation, splicing and the wrong file id", async () => {
    const bytes = randomBytes(64 * 1024 * 2 + 10);
    const sealed = await collect(sealArtifact(key, "file-1", from(bytes)));
    const open = (data: Buffer, fileId = "file-1") =>
      collect(openArtifact(async () => key, fileId, from(data)));
    await expect(open(sealed, "file-2")).rejects.toThrow(ContentDecryptionError);
    await expect(open(sealed.subarray(0, sealed.length - 30))).rejects.toThrow(
      ContentDecryptionError,
    );
    const header = sealed.length - (64 * 1024 + 16) * 2 - (10 + 16);
    await expect(open(sealed.subarray(0, header + 64 * 1024 + 16))).rejects.toThrow(
      ContentDecryptionError,
    );
    const swapped = Buffer.concat([
      sealed.subarray(0, header),
      sealed.subarray(header + 64 * 1024 + 16, header + 2 * (64 * 1024 + 16)),
      sealed.subarray(header, header + 64 * 1024 + 16),
      sealed.subarray(header + 2 * (64 * 1024 + 16)),
    ]);
    await expect(open(swapped)).rejects.toThrow(ContentDecryptionError);
  });

  it("does not treat plaintext as sealed", () => {
    expect(isSealedArtifact(Buffer.from("%PDF-1.7"))).toBe(false);
  });
});
