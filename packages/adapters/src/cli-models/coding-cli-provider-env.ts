/**
 * Empty / unknown / cursor-without-key becomes none so the API still boots and the computer
 * coding CLI tool stays uninjected.
 */
export function resolveCodingCliProvider(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.CODING_CLI_PROVIDER;
  if (configured !== undefined && !configured.trim()) return "none";
  const requested = (configured?.trim() || "none").toLowerCase();
  if (requested === "none" || requested === "") return "none";
  if (requested === "cursor") {
    return optional(source.CURSOR_API_KEY) ? "cursor" : "none";
  }
  return "none";
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
