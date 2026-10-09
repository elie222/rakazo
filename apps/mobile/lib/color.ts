export function transparentColor(color: string): string {
  const channels = colorChannels(color.trim());
  if (!channels) return "transparent";
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, 0)`;
}

function colorChannels(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color);
  if (hex) {
    const digits = hex[1] ?? "";
    const expanded =
      digits.length <= 4 ? [...digits].map((channel) => channel + channel).join("") : digits;
    return [
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
    ];
  }

  const rgb =
    /^rgba?\(\s*([0-9.]+%?)\s+([0-9.]+%?)\s+([0-9.]+%?)(?:\s*\/\s*[0-9.]+%?)?\s*\)$/i.exec(color) ??
    /^rgba?\(\s*([0-9.]+%?)\s*,\s*([0-9.]+%?)\s*,\s*([0-9.]+%?)(?:\s*,\s*[0-9.]+%?)?\s*\)$/i.exec(
      color,
    );
  if (!rgb) return null;
  return [colorChannel(rgb[1] ?? ""), colorChannel(rgb[2] ?? ""), colorChannel(rgb[3] ?? "")];
}

function colorChannel(raw: string): number {
  const value = raw.endsWith("%") ? (Number.parseFloat(raw) / 100) * 255 : Number.parseFloat(raw);
  return Math.round(value);
}
