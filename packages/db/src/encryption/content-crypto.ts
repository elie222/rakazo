import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Versioned content ciphertext: `rkz1:<space key id>:<base64url(iv | ciphertext | tag)>`.
 * AES-256-GCM with a fresh 96-bit IV per value. The AAD binds the table, column,
 * row id, the row's owner (thread, document or user) and the key's space, so a
 * value copied, or a row moved, anywhere else fails authentication.
 */
export const CIPHERTEXT_PREFIX = "rkz1:";
/** JSON values keep query-relevant scalar keys beside the sealed original. */
export const SEALED_FIELD = "$sealed";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD_VERSION = "rakazo/content/v1";

export interface DataKey {
  /** SpaceKey row id; travels in every ciphertext header. */
  id: string;
  spaceId: string;
  version: number;
  key: Uint8Array;
}

export interface ContentLocation {
  table: string;
  column: string;
  rowId: string;
  /** The parent the row belongs to (thread, document or user), so moving the row fails. */
  owner: string;
}

export class ContentDecryptionError extends Error {
  constructor(message = "Encrypted content could not be decrypted") {
    super(message);
    this.name = "ContentDecryptionError";
  }
}

/** A parse error for authenticated content. Its message never contains the plaintext. */
export class EncryptedJsonSyntaxError extends SyntaxError {
  constructor() {
    super("Invalid encrypted JSON");
  }
}

function contentAad(location: ContentLocation, spaceId: string): Buffer {
  return Buffer.from(
    [AAD_VERSION, location.table, location.column, location.rowId, location.owner, spaceId].join(
      "\0",
    ),
  );
}

export function isCiphertext(value: unknown): value is string {
  return ciphertextKeyId(value) !== undefined;
}

export function ciphertextKeyId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(CIPHERTEXT_PREFIX)) return;
  const end = value.indexOf(":", CIPHERTEXT_PREFIX.length);
  return end > CIPHERTEXT_PREFIX.length ? value.slice(CIPHERTEXT_PREFIX.length, end) : undefined;
}

export function encryptText(key: DataKey, location: ContentLocation, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  cipher.setAAD(contentAad(location, key.spaceId));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const body = Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64url");
  return `${CIPHERTEXT_PREFIX}${key.id}:${body}`;
}

export function decryptText(key: DataKey, location: ContentLocation, value: string): string {
  const keyId = ciphertextKeyId(value);
  if (keyId !== key.id) throw new ContentDecryptionError("Encrypted content names another key");
  const body = Buffer.from(value.slice(CIPHERTEXT_PREFIX.length + keyId.length + 1), "base64url");
  if (body.length < IV_BYTES + TAG_BYTES) throw new ContentDecryptionError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.key, body.subarray(0, IV_BYTES));
    decipher.setAAD(contentAad(location, key.spaceId));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(body.subarray(IV_BYTES, body.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ContentDecryptionError();
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSealedJson(value: unknown): value is { [SEALED_FIELD]: string } {
  return isRecord(value) && isCiphertext(value[SEALED_FIELD]);
}

/**
 * Seals a JSON column. Arrays seal per element (message blocks), anything else as
 * one value. Each sealed element keeps copies of `plainKeys` scalars so existing
 * JSON filters (`array_contains`, `path`) still match; the sealed copy is the
 * source of truth on read.
 */
export function sealJson(
  value: unknown,
  plainKeys: ReadonlySet<string>,
  seal: (plaintext: string) => string,
): Json {
  const one = (item: unknown): Json => {
    const sealed: Record<string, Json> = {};
    if (isRecord(item))
      for (const key of plainKeys) {
        const field = item[key];
        if (field === null || ["string", "number", "boolean"].includes(typeof field))
          sealed[key] = field as Json;
      }
    sealed[SEALED_FIELD] = seal(JSON.stringify(item));
    return sealed;
  };
  return Array.isArray(value) ? value.map(one) : one(value);
}

/** Plaintext values pass through, so rows written before encryption stay readable. */
export function openJson(value: unknown, open: (ciphertext: string) => string): unknown {
  const one = (item: unknown) => {
    if (!isSealedJson(item)) return item;
    const plaintext = open(item[SEALED_FIELD]);
    try {
      return JSON.parse(plaintext) as unknown;
    } catch (error) {
      // A JSON parse error can quote the decrypted content.
      if (error instanceof SyntaxError) throw new EncryptedJsonSyntaxError();
      throw error;
    }
  };
  return Array.isArray(value) ? value.map(one) : one(value);
}

export function jsonKeyIds(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) =>
    isSealedJson(item) ? [ciphertextKeyId(item[SEALED_FIELD])!] : [],
  );
}

/** True when a JSON column holds anything not yet sealed. Empty arrays count as sealed. */
export function jsonNeedsSealing(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value];
  return items.some((item) => !isSealedJson(item));
}

// Blind index for search over encrypted messages. Tokens are keyed HMACs of
// normalized words, prefixes and Han pairs, truncated to 32 bits: equality and
// frequency within a space are visible to a database reader, words are not.
// Collisions only cost a false candidate, which callers filter after decryption.

export type SearchTokenDomain = "word" | "prefix";

const MAX_PREFIX = 10;
const MIN_PREFIX = 2;
// At most 1 KiB of int32 payload for Han pairs. A prime modulus spreads sequences
// of adjacent Unicode code points across the compact buckets.
const HAN_PAIR_BUDGET = 251;

function searchKey(key: DataKey): Buffer {
  return Buffer.from(hkdfSync("sha256", key.key, Buffer.alloc(0), "rakazo/search/v1", 32));
}

export function searchTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ];
}

function token(hmacKey: Buffer, domain: SearchTokenDomain, term: string): number {
  return createHmac("sha256", hmacKey).update(`${domain}\0${term}`).digest().readInt32BE(0);
}

// Overlapping code-point pairs include each immediate Han/script boundary.
// All terms have already been normalized to contiguous letters and numbers.
function messagePrefixParts(terms: string[], allowLeadingSuffix = false) {
  const words = new Set<string>();
  const pairs = new Set<string>();
  const buckets = new Set<number>();
  let compact = false;
  let splitWord = false;
  for (const term of terms) {
    for (const match of term.matchAll(/[^\p{Script=Han}]+/gu)) {
      const word = match[0];
      if (word !== term) splitWord = true;
      // "PI服" can start inside "API服务". The I/服 boundary qualifies the
      // candidate even though PI is a suffix. The opened text verifies PI.
      if (allowLeadingSuffix && term === terms[0] && match.index === 0 && word !== term) continue;
      words.add(word);
    }
    if (compact && buckets.size === HAN_PAIR_BUDGET) continue;
    for (const match of term.matchAll(/(?=(\p{Script=Han}.|.\p{Script=Han}))/gu)) {
      const pair = match[1]!;
      const left = pair.codePointAt(0)!;
      const right = pair.codePointAt(left > 0xffff ? 2 : 1)!;
      buckets.add((31 * left + right) % HAN_PAIR_BUDGET);
      if (!compact) {
        if (pairs.size === HAN_PAIR_BUDGET && !pairs.has(pair)) compact = true;
        else pairs.add(pair);
      }
      if (compact && buckets.size === HAN_PAIR_BUDGET) break;
    }
  }
  const bucketTerms = Array.from(buckets, (id) => `\0han-pair-bucket/${id}`);
  return { words, pairs, bucketTerms, compact, splitWord };
}

function* wordPrefixes(words: Iterable<string>) {
  for (const word of words)
    for (let length = MIN_PREFIX; length <= Math.min(word.length, MAX_PREFIX); length++)
      yield word.slice(0, length);
}

// Normalized words cannot contain a NUL. A split word or interior pair must
// never qualify a row for the candidate window reserved for original prefixes.
const hanPairTerm = (pair: string) => `\0han-pair/${pair}`;
const splitPrefixTerm = (prefix: string) => `\0split-prefix/${prefix}`;

/** Hash history words, word prefixes and complete prefix-domain fragments into one stored array. */
export function wordAndPrefixTokens(
  key: DataKey,
  historyText: string,
  prefixWords: Iterable<string>,
  fragments: Iterable<string> = [],
): number[] {
  const hmacKey = searchKey(key);
  const tokens = new Set<number>();
  for (const term of searchTerms(historyText)) tokens.add(token(hmacKey, "word", term));
  const prefixes = new Set(fragments);
  for (const prefix of wordPrefixes(prefixWords)) prefixes.add(prefix);
  for (const prefix of prefixes) tokens.add(token(hmacKey, "prefix", prefix));
  return [...tokens].sort((a, b) => a - b);
}

export function searchTokens(
  key: DataKey,
  input: { words: string; strings: string[] },
  format: "han-pairs" | "prefix" = "prefix",
): number[] {
  const terms = searchTerms(input.strings.join("\n"));
  if (format === "prefix") return wordAndPrefixTokens(key, input.words, terms);
  const { words, pairs, bucketTerms, compact, splitWord } = messagePrefixParts(terms);
  if (!pairs.size && !splitWord) return wordAndPrefixTokens(key, input.words, terms);
  return wordAndPrefixTokens(key, input.words, terms, [
    ...(compact ? bucketTerms : Array.from(pairs, hanPairTerm)),
    ...(splitWord ? Array.from(wordPrefixes(words), splitPrefixTerm) : []),
  ]);
}

function queryPrefixes(terms: Iterable<string>): string[] {
  return [...terms]
    .filter((term) => term.length >= MIN_PREFIX)
    .map((term) => term.slice(0, MAX_PREFIX));
}

/**
 * Exact history words or the original prefix-only query encoding. Space search
 * uses prefixQueryTokenSets to cover both current and legacy message indexes.
 */
export function querySearchTokens(
  key: DataKey,
  query: string,
  domain: SearchTokenDomain,
): number[] {
  const hmacKey = searchKey(key);
  const terms = searchTerms(query);
  if (domain === "word") return terms.map((term) => token(hmacKey, "word", term));
  return queryPrefixes(terms).map((term) => token(hmacKey, "prefix", term));
}

export interface PrefixQueryTokenSets {
  legacy: number[][];
  exact: number[][];
  compact: number[][];
}

/** Keep the historical predicate and the two Han representations independently pageable. */
export function prefixQueryTokenSets(key: DataKey, query: string): PrefixQueryTokenSets {
  const terms = searchTerms(query);
  const { words, pairs, bucketTerms, compact: oversized } = messagePrefixParts(terms, true);
  const prefixes = queryPrefixes(words);
  const hmacKey = searchKey(key);
  const hash = (prefix: string) => token(hmacKey, "prefix", prefix);
  // Older indexes may remain for as long as a self-hosted backfill is paused.
  const legacy = [queryPrefixes(terms).map(hash)];
  const originalWords = prefixes.map(hash);
  const splitWords = prefixes.map((prefix) => hash(splitPrefixTerm(prefix)));
  // Messages with no mixed-script term already store their non-Han words as
  // original prefixes. A mixed-script message also stores its split word runs.
  const withWords = (han: number[]) => {
    if (!han.length) return splitWords.length ? [splitWords] : [];
    if (!splitWords.length) return [han];
    return [
      [...han, ...originalWords],
      [...han, ...splitWords],
    ];
  };
  const exact = oversized ? [] : withWords(Array.from(pairs, (pair) => hash(hanPairTerm(pair))));
  const compact = bucketTerms.length ? withWords(bucketTerms.map(hash)) : [];
  return { legacy, exact, compact };
}

// Artifact files: a header naming the key, then 64 KiB AES-GCM segments. Each
// nonce is a random per-file prefix plus the segment counter, and each AAD binds
// the header, space, file id and whether the segment is final, so reordering,
// truncation and splicing between files all fail authentication.

const ARTIFACT_MAGIC = Buffer.from("RKZA\x01", "latin1");
const ARTIFACT_CHUNK = 64 * 1024;
const NONCE_PREFIX_BYTES = 8;

export function isSealedArtifact(head: Uint8Array): boolean {
  return (
    head.length >= ARTIFACT_MAGIC.length &&
    Buffer.from(head.subarray(0, ARTIFACT_MAGIC.length)).equals(ARTIFACT_MAGIC)
  );
}

function segmentCrypto(header: Buffer, prefix: Buffer, spaceId: string, fileId: string) {
  const context = Buffer.from(`\0${spaceId}\0${fileId}\0`);
  return {
    nonce(counter: number) {
      const nonce = Buffer.alloc(IV_BYTES);
      prefix.copy(nonce, 0);
      nonce.writeUInt32BE(counter, NONCE_PREFIX_BYTES);
      return nonce;
    },
    aad(final: boolean) {
      return Buffer.concat([header, context, Buffer.from([final ? 1 : 0])]);
    },
  };
}

async function* rechunk(source: AsyncIterable<Uint8Array>, size: number) {
  let pending = Buffer.alloc(0);
  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    while (pending.length > size) {
      yield pending.subarray(0, size);
      pending = pending.subarray(size);
    }
  }
  yield pending;
}

export async function* sealArtifact(
  key: DataKey,
  fileId: string,
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Buffer> {
  const keyId = Buffer.from(key.id, "utf8");
  if (keyId.length > 255) throw new Error("Space key id is too long");
  const prefix = randomBytes(NONCE_PREFIX_BYTES);
  const header = Buffer.concat([ARTIFACT_MAGIC, Buffer.from([keyId.length]), keyId, prefix]);
  const crypto = segmentCrypto(header, prefix, key.spaceId, fileId);
  yield header;
  let counter = 0;
  let previous: Buffer | undefined;
  const emit = (plaintext: Buffer, final: boolean) => {
    const cipher = createCipheriv("aes-256-gcm", key.key, crypto.nonce(counter++));
    cipher.setAAD(crypto.aad(final));
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  };
  // A full final segment would be indistinguishable from a truncation point, so
  // the last segment is always shorter than a full one (possibly empty).
  for await (const chunk of rechunk(source, ARTIFACT_CHUNK)) {
    if (previous) yield emit(previous, false);
    previous = chunk;
  }
  if (previous!.length === ARTIFACT_CHUNK) {
    yield emit(previous!, false);
    previous = Buffer.alloc(0);
  }
  yield emit(previous!, true);
}

export function artifactKeyId(head: Uint8Array): string | undefined {
  if (!isSealedArtifact(head) || head.length < ARTIFACT_MAGIC.length + 1) return;
  const length = head[ARTIFACT_MAGIC.length]!;
  const start = ARTIFACT_MAGIC.length + 1;
  if (head.length < start + length) return;
  return Buffer.from(head.subarray(start, start + length)).toString("utf8");
}

export async function* openArtifact(
  keyFor: (keyId: string) => Promise<DataKey>,
  fileId: string,
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Buffer> {
  let pending = Buffer.alloc(0);
  let crypto: ReturnType<typeof segmentCrypto> | undefined;
  let key: DataKey | undefined;
  let counter = 0;
  const segment = ARTIFACT_CHUNK + TAG_BYTES;
  const open = (sealed: Buffer, final: boolean) => {
    if (sealed.length < TAG_BYTES)
      throw new ContentDecryptionError("Encrypted artifact is truncated");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key!.key, crypto!.nonce(counter++));
      decipher.setAAD(crypto!.aad(final));
      decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
      return Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new ContentDecryptionError("Encrypted artifact failed authentication");
    }
  };
  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    if (!crypto) {
      const keyId = artifactKeyId(pending);
      if (keyId === undefined) {
        if (pending.length >= ARTIFACT_MAGIC.length + 1 + 255 + NONCE_PREFIX_BYTES)
          throw new ContentDecryptionError("Encrypted artifact header is malformed");
        continue;
      }
      const headerLength =
        ARTIFACT_MAGIC.length + 1 + Buffer.byteLength(keyId) + NONCE_PREFIX_BYTES;
      if (pending.length < headerLength) continue;
      key = await keyFor(keyId);
      if (key.id !== keyId)
        throw new ContentDecryptionError("Encrypted artifact names another key");
      const header = pending.subarray(0, headerLength);
      crypto = segmentCrypto(
        Buffer.from(header),
        Buffer.from(header.subarray(headerLength - NONCE_PREFIX_BYTES)),
        key.spaceId,
        fileId,
      );
      pending = pending.subarray(headerLength);
    }
    while (pending.length > segment) {
      yield open(pending.subarray(0, segment), false);
      pending = pending.subarray(segment);
    }
  }
  if (!crypto) throw new ContentDecryptionError("Encrypted artifact header is malformed");
  if (pending.length >= segment)
    throw new ContentDecryptionError("Encrypted artifact is truncated");
  yield open(pending, true);
}
