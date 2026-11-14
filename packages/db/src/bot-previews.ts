import type { MessageBlock } from "@rakazo/contracts";
import { BACKGROUND_RUN_TRIGGERS, isBackgroundRunTrigger, userVisibleMessages } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { previewFromBlocks } from "./thread-listing.js";

/** Messages scanned per page; enough to skip a short peer-run tail. */
const BOT_PREVIEW_WINDOW = 16;
const BOT_PREVIEW_PAGES = 5;

interface OutlineRow {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  runId: string | null;
  replyToMessageId: string | null;
  createdAt: Date;
  kinds: string[];
  /** Only for peer receipts, whose sealed `intent` decides visibility. */
  blocks: Prisma.JsonValue | null;
}

interface ScannedMessage {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  runId?: string;
  replyToMessageId: string | null;
  createdAt: Date;
  blocks: MessageBlock[];
  /** False while `blocks` holds only each block's kind. */
  loaded: boolean;
}

/**
 * The newest page of messages per thread, before `beforeSeq` when given. Visibility reads only
 * block kinds (stored in the clear beside sealed content) and a peer receipt's intent, so other
 * messages come back without their content.
 */
async function messageOutlines(
  prisma: PrismaClient,
  pages: Array<{ threadId: string; beforeSeq: number | null }>,
): Promise<Map<string, ScannedMessage[]>> {
  const rows =
    pages.length === 0
      ? []
      : await prisma.$queryRaw<OutlineRow[]>(Prisma.sql`
          SELECT m.id, m."threadId", m.seq, m.role, m."runId", m."replyToMessageId", m."createdAt",
            jsonb_path_query_array(m.blocks, '$[*].kind') AS kinds,
            CASE WHEN m.blocks @> '[{"kind":"bot_message_received"}]' THEN m.blocks END AS blocks
          FROM unnest(
            ${pages.map((page) => page.threadId)}::text[],
            ${pages.map((page) => page.beforeSeq)}::int[]
          ) AS t(id, before)
          CROSS JOIN LATERAL (
            SELECT id, "threadId", seq, role, "runId", "replyToMessageId", "createdAt", blocks
            FROM messages
            WHERE "threadId" = t.id AND (t.before IS NULL OR seq < t.before)
            ORDER BY seq DESC
            LIMIT ${BOT_PREVIEW_WINDOW}
          ) m
          ORDER BY m."threadId", m.seq DESC
        `);
  const receipts = rows.filter((row) => row.blocks !== null);
  await contentEncryptionOf(prisma)?.openRows("Message", receipts);
  const byThread = new Map<string, ScannedMessage[]>();
  for (const row of rows) {
    const message: ScannedMessage = {
      id: row.id,
      threadId: row.threadId,
      seq: row.seq,
      role: row.role,
      runId: row.runId ?? undefined,
      replyToMessageId: row.replyToMessageId,
      createdAt: row.createdAt,
      blocks:
        row.blocks === null
          ? row.kinds.map((kind) => ({ kind }) as MessageBlock)
          : (row.blocks as MessageBlock[]),
      loaded: row.blocks !== null,
    };
    const list = byThread.get(row.threadId);
    if (list) list.push(message);
    else byThread.set(row.threadId, [message]);
  }
  return byThread;
}

/**
 * Sidebar preview text per bot thread: the newest user-visible message with text, read page by
 * page. Only the messages the preview is taken from are loaded in full.
 */
export async function botThreadPreviews(prisma: PrismaClient, threadIds: string[]) {
  const peerRunIds = new Set<string>();
  const backgroundRunIds = new Set<string>();
  const checkedRunIds = new Set<string>();
  const classifyRunIds = async (ids: string[]) => {
    const missing = [...new Set(ids)].filter((id) => !checkedRunIds.has(id));
    if (missing.length === 0) return;
    const rows = await prisma.run.findMany({
      where: { id: { in: missing }, trigger: { in: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] } },
      select: { id: true, trigger: true },
    });
    for (const row of rows) {
      if (isBackgroundRunTrigger(row.trigger)) backgroundRunIds.add(row.id);
      else peerRunIds.add(row.id);
    }
    for (const id of missing) checkedRunIds.add(id);
  };

  let pages = await messageOutlines(
    prisma,
    threadIds.map((threadId) => ({ threadId, beforeSeq: null })),
  );
  const newestAt = new Map(
    [...pages].flatMap(([threadId, messages]) =>
      messages[0] ? [[threadId, messages[0].createdAt] as const] : [],
    ),
  );
  const previews = new Map<string, string>();
  for (let page = 1; pages.size > 0; page++) {
    await classifyRunIds(
      [...pages.values()].flat().flatMap((message) => (message.runId ? [message.runId] : [])),
    );
    const visibleByThread = new Map(
      [...pages].map(([threadId, messages]) => [
        threadId,
        userVisibleMessages(messages, {
          knownPeerRunIds: peerRunIds,
          backgroundRunIds,
          includeDelegatedReplyText: false,
        }),
      ]),
    );
    const exhausted: string[] = [];
    let scanning = [...visibleByThread.keys()];
    while (scanning.length > 0) {
      const unloaded = new Map<string, ScannedMessage>();
      for (const threadId of scanning) {
        let next: ScannedMessage | undefined;
        for (const message of visibleByThread.get(threadId) ?? []) {
          if (!message.loaded) {
            next = message;
            break;
          }
          const preview = previewFromBlocks(message.blocks);
          if (preview) {
            previews.set(threadId, preview);
            break;
          }
        }
        if (next) unloaded.set(next.id, next);
        else if (!previews.has(threadId)) exhausted.push(threadId);
      }
      if (unloaded.size === 0) break;
      const loaded = await prisma.message.findMany({
        where: { id: { in: [...unloaded.keys()] } },
        select: { id: true, blocks: true },
      });
      const blocksById = new Map(loaded.map((row) => [row.id, row.blocks as MessageBlock[]]));
      for (const message of unloaded.values()) {
        // A message deleted since the outline read has nothing to preview.
        message.blocks = blocksById.get(message.id) ?? [];
        message.loaded = true;
      }
      scanning = [...new Set([...unloaded.values()].map((message) => message.threadId))];
    }
    if (page === BOT_PREVIEW_PAGES) break;
    pages = await messageOutlines(
      prisma,
      exhausted.flatMap((threadId) => {
        const oldest = pages.get(threadId)?.at(-1);
        return oldest ? [{ threadId, beforeSeq: oldest.seq }] : [];
      }),
    );
  }
  return { previews, newestAt };
}
