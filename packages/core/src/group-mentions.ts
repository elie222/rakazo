export type GroupMemberRef = {
  id: string;
  name: string;
};

export function memberName(
  members: readonly { botId: string; name: string }[] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}

const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_-]{0,39})/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Chinese, Japanese and Korean, whose text runs straight on from a name ("@Writer你看下"). */
export const CJK_CHAR =
  "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]";
// Any other letter, a digit, "_" or "-" joins a name to the text around it. CJK text ends a name
// only after a name that does not itself end in CJK: "@Writer你看下" names Writer, but "@王五" is
// not "@王".
const NAME_CHAR = `(?!${CJK_CHAR})[\\p{L}\\p{N}_-]`;
const WORD_CHAR = "[\\p{L}\\p{N}_-]";
const ENDS_IN_CJK = new RegExp(`${CJK_CHAR}$`, "u");
const JOINS_BEFORE = new RegExp(`${NAME_CHAR}$`, "u");
const JOINS_AFTER = new RegExp(`^${NAME_CHAR}`, "u");
const JOINS_AFTER_CJK = new RegExp(`^${WORD_CHAR}`, "u");

/** What may not follow `name` for a mention of it to end there. */
function nameEnd(name: string, runsOn: boolean): string {
  return !runsOn && ENDS_IN_CJK.test(name) ? WORD_CHAR : NAME_CHAR;
}

/** Whether a mention from `start` to `end` stands apart from the text around it. */
export function mentionStandsAlone(text: string, start: number, end: number): boolean {
  const joinsAfter = ENDS_IN_CJK.test(text.slice(Math.max(start, end - 2), end))
    ? JOINS_AFTER_CJK
    : JOINS_AFTER;
  return (
    !JOINS_BEFORE.test(text.slice(Math.max(0, start - 2), start)) &&
    !joinsAfter.test(text.slice(end, end + 2))
  );
}

/**
 * Where text names one of `names` with `@`. Each mention takes its longest name. A name in
 * `runsOn`, a word for everyone, may run straight into CJK text even when it ends in CJK
 * ("请@所有人看下").
 */
export function mentionSpans(
  text: string,
  names: readonly string[],
  runsOn: readonly string[] = [],
): { start: number; end: number; name: string }[] {
  const sorted = [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (sorted.length === 0) return [];
  const free = new Set(runsOn.map((name) => name.trim().toLowerCase()));
  const alternatives = sorted
    .map((name) => `${escapeRegExp(name)}(?!${nameEnd(name, free.has(name.toLowerCase()))})`)
    .join("|");
  const pattern = new RegExp(`(?<!${NAME_CHAR})@(${alternatives})`, "giu");
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    name: match[1]!,
  }));
}

/** Words that name every member. A member called "all" or "所有人" is named by that word instead. */
export function everyoneWords(memberNames: readonly string[]): string[] {
  const taken = new Set(memberNames.map((name) => name.trim().toLowerCase()));
  return ["everyone", ...["all", "所有人"].filter((word) => !taken.has(word))];
}

// A fence (``` or ~~~) that opens a line runs to a fence that opens a later line, or to the end,
// as the chat shows it; mid-sentence, only a closed pair of ``` is code. Inline code sits between
// equal runs of backticks on one line. Indented lines are code only after a blank line (or at the
// start) and when they don't begin a nested list item.
const CODE =
  /(?<=^[ \t]{0,3}|\n[ \t]{0,3})(```|~~~)[\s\S]*?(?:\n[ \t]{0,3}\1|(?![\s\S]))|```[\s\S]*?```|(?<!`)(?<ticks>`+)[^`\n](?:[^\n]*?[^`\n])?\k<ticks>(?!`)|(?:^|\n[ \t]*\n)(?: {4}|\t)(?![ \t]*(?:[-*+]|\d+[.)])\s).*(?:\n(?: {4}|\t).*)*/g;
// A link, with or without its scheme ("x.com/path"), runs to the next space, full-width punctuation
// ("x.com/a，@所有人"), closing bracket or quote ("[docs](https://x.com/a)@all"). Chinese text
// can sit inside its path ("x.com/你好@all").
const LINK =
  /(?:\bhttps?:\/\/|\bwww\.|(?<![\w.-])(?=([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}))\1\/)[^\s\u3000-\u303f\uff00-\uff65)\]>"']*/giu;

/** The code and links in `text`, merged and in order, found once however many mentions it has. */
function quotedRanges(text: string): [number, number][] {
  const found = [...text.matchAll(CODE), ...text.matchAll(LINK)]
    .map((match): [number, number] => [match.index, match.index + match[0].length])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of found) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function insideRanges(ranges: readonly [number, number][], position: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle]!;
    if (position < start) high = middle - 1;
    else if (position >= end) low = middle + 1;
    else return true;
  }
  return false;
}

/**
 * Whether each mention in `text` counts in a group. "all" and "所有人" turn up in ordinary text far
 * more than "everyone", so among `everyone` (see everyoneWords) they don't count in code or as
 * part of a link, an address or a package: "x.com/@all", "a@all.com", "@all/pkg".
 */
export function groupMentionCheck(
  text: string,
  everyone: readonly string[],
): (span: { start: number; end: number; name: string }) => boolean {
  let quoted: [number, number][] | undefined;
  return (span) => {
    const word = span.name.toLowerCase();
    if (word === "everyone" || !everyone.includes(word)) return true;
    if (/[/\\.:@+]/.test(text[span.start - 1] ?? "")) return false;
    if (/^[./\\][\p{L}\p{N}_-]/u.test(text.slice(span.end, span.end + 3))) return false;
    quoted ??= quotedRanges(text);
    return !insideRanges(quoted, span.start);
  };
}

/** The names a group message mentions, as written, each read once with its longest name. */
export function groupMentionNames(text: string, memberNames: readonly string[]): string[] {
  const words = everyoneWords(memberNames);
  return mentionSpans(text, [...words, ...memberNames], words)
    .filter(groupMentionCheck(text, words))
    .map((span) => span.name);
}

export function hasMentionToken(text: string, name: string): boolean {
  return mentionSpans(text, [name]).length > 0;
}

export function parseMentionNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    if (name) names.add(name.toLowerCase());
  }
  return [...names];
}

type GroupTargetInput = {
  text: string;
  members: GroupMemberRef[];
  /** Bot ids from typed mention chips (non-members are ignored for wake). */
  explicitMentions?: string[];
};

/** Members a message names (chip, @Name or a word for everyone). Empty when it names nobody. */
export function mentionedGroupBotIds(input: GroupTargetInput): string[] {
  const membersById = new Map(input.members.map((member) => [member.id, member]));
  const targetIds = new Set<string>();

  for (const mentionId of input.explicitMentions ?? []) {
    // Out-of-chat bots stay as @Name in the prompt; only members are woken here.
    if (membersById.has(mentionId)) targetIds.add(mentionId);
  }

  const memberNames = input.members.map((member) => member.name);
  const everyone = everyoneWords(memberNames);
  // Read each mention once, with its longest name, so a full name cannot also wake its prefix.
  const mentions = groupMentionNames(input.text, memberNames);
  const isMentioned = (name: string) => {
    const exactName = new RegExp(`^${escapeRegExp(name.trim())}$`, "iu");
    return mentions.some((mention) => exactName.test(mention));
  };

  if (everyone.some(isMentioned)) {
    for (const member of input.members) targetIds.add(member.id);
  } else {
    for (const member of input.members) {
      if (isMentioned(member.name)) targetIds.add(member.id);
    }
  }

  return [...targetIds];
}

/** Named members wake; a message that names nobody reaches every member. */
export function resolveGroupTargetBotIds(input: GroupTargetInput): string[] {
  const mentioned = mentionedGroupBotIds(input);
  return mentioned.length > 0 ? mentioned : input.members.map((member) => member.id);
}

export function inferHandoffTargetName(prompt: string): string | undefined {
  const handoffMatch =
    /hand(?:\s+this|\s+off|\s+it)?\s+to\s+@?([A-Za-z0-9][A-Za-z0-9_-]{0,39})/i.exec(prompt) ??
    /@([A-Za-z0-9][A-Za-z0-9_-]{0,39})\s+take/i.exec(prompt);
  return handoffMatch?.[1];
}

export function inferHandoffTargetBotId(
  prompt: string,
  members: GroupMemberRef[],
): string | undefined {
  const handedTo = members.find((member) => {
    const escaped = escapeRegExp(member.name.trim());
    return escaped
      ? new RegExp(`\\bto\\s+@?${escaped}(?![\\p{L}\\p{N}_-])`, "iu").test(prompt)
      : false;
  });
  if (handedTo) return handedTo.id;
  const mentioned = members.find((member) => hasMentionToken(prompt, member.name));
  if (mentioned) return mentioned.id;
  const name = inferHandoffTargetName(prompt)?.toLowerCase();
  return name ? members.find((member) => member.name.toLowerCase() === name)?.id : undefined;
}
