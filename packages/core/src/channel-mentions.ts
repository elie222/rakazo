export interface MentionCandidate {
  botId: string;
  name: string;
}

const MENTION_WORD_CHARACTER = /[\p{L}\p{N}_-]/u;

function codePointBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const previous = index - 1;
  const codeUnit = text.charCodeAt(previous);
  const start = codeUnit >= 0xdc00 && codeUnit <= 0xdfff && previous > 0 ? previous - 1 : previous;
  const point = text.codePointAt(start);
  return point === undefined ? "" : String.fromCodePoint(point);
}

function codePointAfter(text: string, index: number): string {
  const point = text.codePointAt(index);
  return point === undefined ? "" : String.fromCodePoint(point);
}

function overlaps(start: number, end: number, spans: Array<{ start: number; end: number }>) {
  return spans.some((span) => start < span.end && end > span.start);
}

/**
 * Bots in a channel only speak when they are named, so a posted message wakes exactly the
 * members it mentions. Longer names match first and are consumed, so "@Chief of Staff" does
 * not also wake a bot called "Chief".
 */
export function mentionedBotIds(text: string, members: MentionCandidate[]): string[] {
  const normalizedMembers = members.flatMap((member) => {
    const name = member.name.trim().toLowerCase();
    return name ? [{ ...member, normalizedName: name }] : [];
  });
  const orderedNames = [...new Set(normalizedMembers.map((member) => member.normalizedName))].sort(
    (a, b) => b.length - a.length,
  );
  const lowerText = text.toLowerCase();
  const occupied: Array<{ start: number; end: number }> = [];
  const matchedNames = new Set<string>();

  for (const name of orderedNames) {
    const needle = `@${name}`;
    let start = lowerText.indexOf(needle);
    while (start !== -1) {
      const end = start + needle.length;
      const before = codePointBefore(lowerText, start);
      const after = codePointAfter(lowerText, end);
      const bounded =
        (!before || !MENTION_WORD_CHARACTER.test(before)) &&
        (!after || !MENTION_WORD_CHARACTER.test(after));
      if (bounded && !overlaps(start, end, occupied)) {
        occupied.push({ start, end });
        matchedNames.add(name);
      }
      start = lowerText.indexOf(needle, start + needle.length);
    }
  }

  return [
    ...new Set(
      normalizedMembers
        .filter((member) => matchedNames.has(member.normalizedName))
        .map((member) => member.botId),
    ),
  ];
}
