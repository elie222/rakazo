/**
 * Match a BCP-47 tag (`de-DE`, `pt`, `es-419`, `zh_Hans_CN`, legacy `iw`) to one of the
 * `supported` UI locales, else English. Each surface ships its own catalogs, so it passes its own
 * list.
 */
export function matchUiLocale<L extends string>(
  raw: string | null | undefined,
  supported: readonly L[],
): L | "en" {
  const candidate = uiLocaleCandidate(raw);
  return (supported as readonly string[]).includes(candidate) ? (candidate as L) : "en";
}

function uiLocaleCandidate(raw: string | null | undefined): string {
  if (!raw) return "en";
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "pt" || normalized.startsWith("pt-")) return "pt-BR";
  if (normalized === "es" || normalized.startsWith("es-")) return "es";
  // `iw` is the legacy ISO 639 code for Hebrew that some browsers and Android still report.
  if (normalized === "iw" || normalized.startsWith("iw-")) return "he";
  // Explicit script takes precedence over region (for example zh-Hans-TW).
  const [language, scriptOrRegion] = normalized.split("-");
  if (
    language === "zh" &&
    (scriptOrRegion === "hant" ||
      scriptOrRegion === "tw" ||
      scriptOrRegion === "hk" ||
      scriptOrRegion === "mo")
  ) {
    return "zh-TW";
  }
  if (language === "zh") return "zh-CN";
  return normalized.split("-")[0] ?? "";
}
