/**
 * A voice for a bot that no other bot has, starting from a spot set by the bot's id so the
 * same bot tends to land on the same voice. When every voice is taken, bots share.
 */
export function pickUnusedVoice(
  voices: readonly string[],
  taken: ReadonlySet<string>,
  botId: string,
) {
  let hash = 0;
  for (const char of botId) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  const start = hash % voices.length;
  for (let offset = 0; offset < voices.length; offset += 1) {
    const voice = voices[(start + offset) % voices.length];
    if (voice && !taken.has(voice)) return voice;
  }
  return voices[start] as string;
}
