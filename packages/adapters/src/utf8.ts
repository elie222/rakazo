export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(
  value: string,
  maxBytes: number,
  keep: "start" | "end" = "start",
): string {
  if (maxBytes <= 0) return "";
  const characters: string[] = [];
  let bytes = 0;
  for (const character of keep === "end" ? Array.from(value).reverse() : value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return (keep === "end" ? characters.reverse() : characters).join("");
}
