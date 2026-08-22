export interface MentionCandidate {
  botId: string;
  name: string;
}

/**
 * Bots in a channel only speak when they are named, so a posted message wakes exactly the
 * members it mentions. Longer names match first and are consumed, so "@Chief of Staff" does
 * not also wake a bot called "Chief".
 */
export function mentionedBotIds(text: string, members: MentionCandidate[]): string[] {
  const ordered = [...members]
    .filter((member) => member.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  let remaining = text.toLowerCase();
  const hits: string[] = [];
  for (const member of ordered) {
    const needle = `@${member.name.trim().toLowerCase()}`;
    if (!remaining.includes(needle)) continue;
    remaining = remaining.split(needle).join(" ");
    hits.push(member.botId);
  }
  return hits;
}
