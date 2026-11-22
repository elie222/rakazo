import { byteLength, escapePromptData, truncateUtf8 } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { ScratchpadToolDeps } from "../../tasks/scratchpad-tools.js";
import { listScratchpadItems } from "../../tasks/scratchpad-tools.js";
import {
  SCRATCHPAD_CLOSING,
  SCRATCHPAD_CUT_HINT,
  SCRATCHPAD_PREAMBLE,
  scratchpadMoreItemsNote,
  scratchpadParkedNote,
} from "./scratchpad-context.prompt.js";

const MAX_SCRATCHPAD_CONTEXT_BYTES = 4 * 1024;
const MAX_OPEN_ITEMS = 40;
const NOTES_SEPARATOR = " — ";
const CUT = "…";

export async function loadAgentScratchpadContext(
  deps: ScratchpadToolDeps | { prisma: PrismaClient },
  input: { spaceId: string; botId: string },
  maxBytes = MAX_SCRATCHPAD_CONTEXT_BYTES,
): Promise<string | undefined> {
  // Parked work is set aside: it is counted here and read on demand, so it never crowds out open work.
  const [items, parked] = await Promise.all([
    listScratchpadItems(deps, { spaceId: input.spaceId, botId: input.botId, status: "open" }),
    deps.prisma.scratchpadItem.count({
      where: { spaceId: input.spaceId, botId: input.botId, status: "parked" },
    }),
  ]);
  if (items.length === 0 && parked === 0) return undefined;

  const fixedBytes = byteLength(SCRATCHPAD_PREAMBLE) + byteLength(SCRATCHPAD_CLOSING);
  if (maxBytes <= fixedBytes)
    return truncateUtf8(`${SCRATCHPAD_PREAMBLE}${SCRATCHPAD_CLOSING}`, maxBytes);

  const entries = items.slice(0, MAX_OPEN_ITEMS).map((item, index) => ({
    head: `${index === 0 ? "" : "\n"}- [${item.status}] ${escapePromptData(item.title)}`,
    notes: escapePromptData(item.notes.trim()),
    tail: ` (id: ${escapePromptData(item.id)})`,
  }));
  const more =
    (items.length > MAX_OPEN_ITEMS ? scratchpadMoreItemsNote(items.length - MAX_OPEN_ITEMS) : "") +
    (parked > 0 ? scratchpadParkedNote(parked) : "");
  const bodyBytes = maxBytes - fixedBytes;
  const titles = entries.map((entry) => entry.head + entry.tail).join("");
  const withoutNotes = titles + more;
  // Titles alone overflow: keep what fits, newest first, and always the counts and hints after them.
  if (byteLength(withoutNotes) >= bodyBytes) {
    return `${SCRATCHPAD_PREAMBLE}${keepEnding(titles, more, bodyBytes)}${SCRATCHPAD_CLOSING}`;
  }

  // Every item keeps its title, so one long note cannot hide the other open work.
  const wanted = entries.map((entry) =>
    entry.notes ? byteLength(NOTES_SEPARATOR) + byteLength(entry.notes) : 0,
  );
  const notesBytes = bodyBytes - byteLength(withoutNotes);
  const fits = wanted.reduce((sum, bytes) => sum + bytes, 0) <= notesBytes;
  const hint = fits ? "" : truncateUtf8(SCRATCHPAD_CUT_HINT, bodyBytes);
  if (byteLength(hint) > notesBytes) {
    return `${SCRATCHPAD_PREAMBLE}${keepEnding(titles, more + hint, bodyBytes)}${SCRATCHPAD_CLOSING}`;
  }
  const granted = fits ? wanted : shareBytes(wanted, notesBytes - byteLength(hint));
  const lines = entries.map((entry, index) => {
    if (granted[index] === wanted[index]) {
      return `${entry.head}${entry.notes ? NOTES_SEPARATOR + entry.notes : ""}${entry.tail}`;
    }
    const kept = truncateUtf8(
      entry.notes,
      granted[index]! - byteLength(NOTES_SEPARATOR) - byteLength(CUT),
    );
    const cutNote =
      granted[index]! >= byteLength(NOTES_SEPARATOR + CUT) ? NOTES_SEPARATOR + kept + CUT : "";
    return `${entry.head}${cutNote}${entry.tail}`;
  });
  return `${SCRATCHPAD_PREAMBLE}${lines.join("")}${more}${hint}${SCRATCHPAD_CLOSING}`;
}

/** Cuts `text` so `ending` still fits after it within `maxBytes`. */
function keepEnding(text: string, ending: string, maxBytes: number): string {
  const kept = truncateUtf8(ending, maxBytes);
  return truncateUtf8(text, maxBytes - byteLength(kept)) + kept;
}

/** Splits `total` so short requests are met in full and the longest share what is left. */
function shareBytes(wanted: readonly number[], total: number): number[] {
  const granted = wanted.map(() => 0);
  let left = total;
  const smallestFirst = wanted.map((_, index) => index).sort((a, b) => wanted[a]! - wanted[b]!);
  smallestFirst.forEach((index, position) => {
    granted[index] = Math.min(wanted[index]!, Math.floor(left / (smallestFirst.length - position)));
    left -= granted[index]!;
  });
  return granted;
}
