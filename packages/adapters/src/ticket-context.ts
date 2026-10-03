import { parseTicketRef } from "@rakazo/contracts";
import { coerceTicketStatus, type PrismaClient } from "@rakazo/db";

const MAX_TICKET_CONTEXT_BYTES = 4 * 1024;

/** Cheap pre-check so runs without a ref-like token never touch the database. */
const TICKET_REF_HINT = /\b[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*\b/;

export type TicketContextEntry = {
  ref: string;
  title: string;
  status: string;
  assignee: string | null;
  lastComment: string | null;
};

/**
 * Extract ticket references such as `RAK-42` from free text. Only the board's
 * prefix matches, matching is case-insensitive, duplicates collapse to their
 * first occurrence, and a bare prefix or `RAK-0` never matches. A reference must
 * not be preceded by an alphanumeric character, so `XRAK-1` does not match `RAK`.
 */
export function extractTicketRefs(text: string, prefix: string): string[] {
  const normalizedPrefix = prefix.trim().toUpperCase();
  if (!normalizedPrefix) return [];
  const escaped = normalizedPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}-([1-9][0-9]*)(?![0-9])`, "gi");
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const number = match[1];
    if (!number) continue;
    const ref = `${normalizedPrefix}-${number}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

/** Render a compact, untrusted-data context block for referenced tickets. */
export function renderTicketContext(
  entries: TicketContextEntry[],
  maxBytes = MAX_TICKET_CONTEXT_BYTES,
): string | undefined {
  if (entries.length === 0) return undefined;

  const opening = "<tickets_referenced>";
  const closing = "</tickets_referenced>";
  const fixedBytes = byteLength(opening) + byteLength(closing) + 2;
  if (maxBytes <= fixedBytes) return truncateUtf8(`${opening}\n${closing}`, maxBytes);

  const lines: string[] = [];
  let remainingBytes = maxBytes - fixedBytes;
  for (const entry of entries) {
    const assignee = entry.assignee ? ` — assignee: ${escapePromptData(entry.assignee)}` : "";
    const comment = entry.lastComment
      ? ` — last comment: ${escapePromptData(entry.lastComment)}`
      : "";
    const line = `${lines.length === 0 ? "" : "\n"}- ${escapePromptData(entry.ref)} [${escapePromptData(
      entry.status,
    )}] ${escapePromptData(entry.title)}${assignee}${comment}`;
    const lineBytes = byteLength(line);
    if (lineBytes > remainingBytes) {
      const truncated = truncateUtf8(line, remainingBytes);
      if (truncated) lines.push(truncated);
      remainingBytes = 0;
      break;
    }
    lines.push(line);
    remainingBytes -= lineBytes;
  }

  return `${opening}\n${lines.join("")}\n${closing}`;
}

export async function loadAgentTicketContext(
  deps: { prisma: PrismaClient },
  input: { spaceId: string; text: string },
  maxBytes = MAX_TICKET_CONTEXT_BYTES,
): Promise<string | undefined> {
  if (!TICKET_REF_HINT.test(input.text)) return undefined;

  const board = await deps.prisma.board.findUnique({ where: { spaceId: input.spaceId } });
  if (!board) return undefined;

  const refs = extractTicketRefs(input.text, board.ticketPrefix);
  if (refs.length === 0) return undefined;

  const wanted = refs.flatMap((ref) => {
    const parsed = parseTicketRef(ref, board.ticketPrefix);
    return parsed ? [{ ref, number: parsed.number }] : [];
  });
  if (wanted.length === 0) return undefined;

  const rows = await deps.prisma.ticket.findMany({
    where: {
      spaceId: input.spaceId,
      boardId: board.id,
      number: { in: wanted.map((item) => item.number) },
    },
  });
  if (rows.length === 0) return undefined;

  const comments = await deps.prisma.ticketComment.findMany({
    where: { spaceId: input.spaceId, ticketId: { in: rows.map((row) => row.id) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const lastCommentByTicket = new Map<string, string>();
  for (const comment of comments) lastCommentByTicket.set(comment.ticketId, comment.body);

  const assigneeBotIds = [
    ...new Set(
      rows.map((row) => row.assigneeBotId).filter((botId): botId is string => Boolean(botId)),
    ),
  ];
  const bots = assigneeBotIds.length
    ? await deps.prisma.bot.findMany({
        where: { id: { in: assigneeBotIds } },
        select: { id: true, name: true },
      })
    : [];
  const botNameById = new Map(bots.map((bot) => [bot.id, bot.name]));
  const rowByNumber = new Map(rows.map((row) => [row.number, row]));

  const entries: TicketContextEntry[] = [];
  for (const item of wanted) {
    const row = rowByNumber.get(item.number);
    if (!row) continue;
    entries.push({
      ref: item.ref,
      title: row.title,
      status: coerceTicketStatus(row.status),
      assignee: row.assigneeBotId ? (botNameById.get(row.assigneeBotId) ?? null) : null,
      lastComment: lastCommentByTicket.get(row.id)?.trim() || null,
    });
  }
  return renderTicketContext(entries, maxBytes);
}

function escapePromptData(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join("");
}
