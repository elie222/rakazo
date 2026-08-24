export type GroupMemberRef = {
  id: string;
  name: string;
};

const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_-]{0,39})/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasMentionToken(text: string, name: string): boolean {
  const normalized = name.trim();
  if (!normalized) return false;
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_-])@${escapeRegExp(normalized)}(?![\\p{L}\\p{N}_-])`,
    "iu",
  ).test(text);
}

export function parseMentionNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    if (name) names.add(name.toLowerCase());
  }
  return [...names];
}

export function filterSelectedMentionsByText<T extends { name: string }>(
  text: string,
  mentions: readonly T[],
): T[] {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1]?.toLowerCase();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const used = new Map<string, number>();
  return mentions.filter((mention) => {
    const key = mention.name.trim().toLowerCase();
    if (!key) return false;
    const allowed = counts.get(key) ?? 0;
    const taken = used.get(key) ?? 0;
    if (taken >= allowed) return false;
    used.set(key, taken + 1);
    return true;
  });
}

export function resolveGroupTargetBotIds(input: {
  text: string;
  members: GroupMemberRef[];
  explicitMentions?: string[];
}): string[] {
  const membersById = new Map(input.members.map((member) => [member.id, member]));
  const targetIds = new Set<string>();

  for (const mentionId of input.explicitMentions ?? []) {
    if (membersById.has(mentionId)) targetIds.add(mentionId);
  }

  if (hasMentionToken(input.text, "everyone")) {
    for (const member of input.members) targetIds.add(member.id);
  } else {
    for (const member of input.members) {
      if (hasMentionToken(input.text, member.name)) targetIds.add(member.id);
    }
  }

  if (targetIds.size === 0 && input.members[0]) {
    targetIds.add(input.members[0].id);
  }

  return [...targetIds];
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
