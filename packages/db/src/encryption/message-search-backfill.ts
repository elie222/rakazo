import type { PrismaClient } from "../database/client.js";
import { Prisma } from "../database/client.js";
import { currentDbContext } from "../database/row-security.js";
import { storedMessageBlocks } from "../threads/message-blocks.js";
import {
  ContentDecryptionError,
  EncryptedJsonSyntaxError,
  jsonKeyIds,
  SEALED_FIELD,
  searchTokens,
} from "./content-crypto.js";
import type { ContentEncryption } from "./content-encryption.js";
import { contentEncryptionOf, messageBlockSearchInput } from "./content-encryption.js";
import { ContentKeyUnavailableError } from "./content-keys.js";

// One checkpoint for the transition from the original prefix index to Han pairs.
const INDEX_VERSION = 2;

interface BackfillProgress {
  scanned: number;
  updated: number;
  complete: boolean;
}

interface SealedMessage {
  id: string;
  threadId: string;
  blocks: Prisma.JsonValue;
  searchTokens: number[] | null;
}

async function openBackfillMessage(encryption: ContentEncryption, row: SealedMessage) {
  // Capture the original key before openRows decrypts the row in place. The
  // space's current key may have rotated since this message was written.
  const { blocks } = row;
  const envelopes = (Array.isArray(blocks) ? blocks : [blocks]).filter(
    (block) => block && typeof block === "object" && Object.hasOwn(block, SEALED_FIELD),
  );
  const ids = jsonKeyIds(envelopes);
  const keyId = ids[0];
  const errorMessage = `Could not read encrypted blocks for message ${row.id}`;
  // An unreadable envelope must stop the batch even when its siblings decrypt.
  if (!keyId || ids.length !== envelopes.length) throw new ContentDecryptionError(errorMessage);
  try {
    const key = await encryption.ring.byId(keyId);
    const [message] = await encryption.openRows("Message", [row]);
    return { key, message: message! };
  } catch (error) {
    if (
      error instanceof ContentDecryptionError ||
      error instanceof ContentKeyUnavailableError ||
      error instanceof EncryptedJsonSyntaxError
    )
      throw new ContentDecryptionError(errorMessage);
    throw error;
  }
}

async function rebuildPage(
  tx: Prisma.TransactionClient,
  encryption: ContentEncryption,
  ids: string[],
): Promise<number> {
  if (!ids.length) return 0;
  const rows = await tx.$queryRaw<SealedMessage[]>`
    SELECT id, "threadId", blocks, "searchTokens" FROM messages
    WHERE id = ANY(${ids}::text[]) AND blocks @? '$[*]."$sealed"'
    ORDER BY id FOR UPDATE`;
  let updated = 0;
  for (const row of rows) {
    const { key, message } = await openBackfillMessage(encryption, row);
    const tokens = searchTokens(
      key,
      messageBlockSearchInput(storedMessageBlocks(message)),
      "han-pairs",
    );
    const existing = row.searchTokens;
    if (existing?.length === tokens.length && tokens.every((value, i) => value === existing[i]))
      continue;
    updated += await tx.$executeRaw`
      UPDATE messages SET "searchTokens" = ${tokens}::int[] WHERE id = ${row.id}`;
  }
  return updated;
}

export async function backfillMessageSearchIndex(
  prisma: PrismaClient,
  options: {
    batchSize?: number;
    maxBatches?: number;
    signal?: AbortSignal;
    report?: (progress: BackfillProgress) => void;
  } = {},
): Promise<BackfillProgress> {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    throw new RangeError("batchSize must be a positive integer");
  if (
    options.maxBatches !== undefined &&
    (!Number.isSafeInteger(options.maxBatches) || options.maxBatches < 1)
  )
    throw new RangeError("maxBatches must be a positive integer");
  if (currentDbContext()?.kind !== "system")
    throw new Error("A system context is required for the deployment-wide search index backfill");
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) throw new Error("Search index backfill needs a content encryption client");

  const progress = { scanned: 0, updated: 0, complete: false };
  if (options.signal?.aborted) return progress;
  // A busy deployment can keep appending messages. Bound this pass when it first starts.
  await prisma.$executeRaw`
    INSERT INTO message_search_backfill (version, "throughId")
    SELECT ${INDEX_VERSION}, max(id) FROM messages
    ON CONFLICT (version) DO NOTHING`;

  for (let i = 0; i < (options.maxBatches ?? Infinity) && !options.signal?.aborted; i++) {
    const batch = await prisma.$transaction(
      async (tx) => {
        // Serialize competing invocations. Index writes and the cursor commit together.
        const [checkpoint] = await tx.$queryRaw<
          { afterId: string | null; throughId: string | null }[]
        >`
          SELECT "afterId", "throughId" FROM message_search_backfill
          WHERE version = ${INDEX_VERSION} FOR UPDATE`;
        if (!checkpoint) throw new Error("Missing message search backfill checkpoint");
        const { afterId, throughId } = checkpoint;
        if (afterId === throughId) return { scanned: 0, updated: 0, complete: true };

        const page = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT id FROM messages WHERE id <= ${throughId}
          ${afterId === null ? Prisma.empty : Prisma.sql`AND id > ${afterId}`}
          ORDER BY id LIMIT ${batchSize}`);
        const updated = await rebuildPage(
          tx,
          encryption,
          page.map(({ id }) => id),
        );
        const complete = page.length < batchSize || page.at(-1)?.id === throughId;
        const cursor = complete ? throughId : page.at(-1)!.id;
        await tx.$executeRaw`UPDATE message_search_backfill SET "afterId" = ${cursor} WHERE version = ${INDEX_VERSION}`;
        return { scanned: page.length, updated, complete };
      },
      { timeout: 60_000 },
    );
    progress.scanned += batch.scanned;
    progress.updated += batch.updated;
    progress.complete = batch.complete;
    options.report?.({ ...progress });
    if (progress.complete) break;
  }
  return progress;
}
