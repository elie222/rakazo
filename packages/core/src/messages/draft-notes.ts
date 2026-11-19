import { truncateReplyQuote } from "@rakazo/contracts";

/** A passage of a draft's body the user marked, by offset, and what they want changed there. */
export type DraftNote = { start: number; end: number; note: string };

/** A run of a draft's body, and the index of the note marking it, if any. */
export type DraftSegment = { text: string; note?: number };

/**
 * The notes with one more over `start`–`end`, trimmed of surrounding whitespace and kept in text
 * order. Null when the passage is blank or overlaps a note already there.
 */
export function addDraftNote(
  body: string,
  notes: readonly DraftNote[],
  mark: DraftNote,
): DraftNote[] | null {
  let start = Math.max(0, Math.min(mark.start, mark.end));
  let end = Math.min(body.length, Math.max(mark.start, mark.end));
  while (start < end && /\s/u.test(body[start] ?? "")) start++;
  while (end > start && /\s/u.test(body[end - 1] ?? "")) end--;
  const note = mark.note.trim();
  if (start === end || !note) return null;
  if (notes.some((other) => start < other.end && other.start < end)) return null;
  return [...notes, { start, end, note }].sort((a, b) => a.start - b.start);
}

/**
 * The notes to draw while the user picks a passage to note: with `selection` among them when it
 * could become a note, and its index there; otherwise the notes as they are, and -1.
 */
export function draftNotesWithPending(
  body: string,
  notes: readonly DraftNote[],
  selection: { start: number; end: number } | null,
): { shown: readonly DraftNote[]; pending: number } {
  const added = selection ? addDraftNote(body, notes, { ...selection, note: "pending" }) : null;
  if (!added) return { shown: notes, pending: -1 };
  return { shown: added, pending: added.findIndex((note) => !notes.includes(note)) };
}

/** The note whose passage holds `offset`, by index, or -1. */
export function draftNoteAt(notes: readonly DraftNote[], offset: number): number {
  return notes.findIndex((note) => offset >= note.start && offset < note.end);
}

/** The body split at the notes' passages, so each can be drawn marked. */
export function draftSegments(body: string, notes: readonly DraftNote[]): DraftSegment[] {
  const segments: DraftSegment[] = [];
  let at = 0;
  notes.forEach((note, index) => {
    if (note.start > at) segments.push({ text: body.slice(at, note.start) });
    segments.push({ text: body.slice(note.start, note.end), note: index });
    at = note.end;
  });
  if (at < body.length) segments.push({ text: body.slice(at) });
  return segments;
}

/** The reply a draft's Revise sends: each marked passage, quoted, with what should change. */
export function draftRevisionText(body: string, notes: readonly DraftNote[]): string {
  return notes
    .map(({ start, end, note }) => {
      const passage = truncateReplyQuote(body.slice(start, end).replace(/\s+/gu, " ").trim());
      return `“${passage}” → ${note}`;
    })
    .join("\n");
}
