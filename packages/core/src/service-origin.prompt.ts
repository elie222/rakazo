/** What a bot reads on a message that a program sent with an API key rather than a person typing. */
export function serviceOriginLine(name: string): string {
  const label = name
    .replace(/[[\]"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `[sent with the API key "${label}", not typed by a person in this chat]`;
}
