export type GroupMemberRef = {
  id: string;
  name: string;
};

const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_-]{0,39})/g;

export function parseMentionNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    if (name) names.add(name.toLowerCase());
  }
  return [...names];
}

export function resolveGroupTargetBotIds(input: {
  text: string;
  members: GroupMemberRef[];
  explicitMentions?: string[];
}): string[] {
  const membersById = new Map(input.members.map((member) => [member.id, member]));
  const membersByName = new Map(
    input.members.map((member) => [member.name.toLowerCase(), member.id]),
  );
  const targetIds = new Set<string>();

  for (const mentionId of input.explicitMentions ?? []) {
    if (membersById.has(mentionId)) targetIds.add(mentionId);
  }

  const parsedNames = parseMentionNames(input.text);
  if (parsedNames.includes("everyone")) {
    for (const member of input.members) targetIds.add(member.id);
  } else {
    for (const name of parsedNames) {
      const botId = membersByName.get(name);
      if (botId) targetIds.add(botId);
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
  const lower = prompt.toLowerCase();
  if (lower.includes("@writer")) {
    return members.find((member) => member.name.toLowerCase() === "writer")?.id;
  }
  const name = inferHandoffTargetName(prompt)?.toLowerCase();
  if (!name) return undefined;
  return members.find((member) => member.name.toLowerCase() === name)?.id;
}
