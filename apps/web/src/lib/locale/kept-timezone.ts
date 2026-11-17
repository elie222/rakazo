import type { KeptTimezone } from "@rakazo/core";
import { parseKeptTimezone } from "@rakazo/core";
import { createStoredPreference } from "../preferences/stored-preference";

function parseKept(raw: string | null): Record<string, KeptTimezone> {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).flatMap(([userId, entry]) => {
        const kept = parseKeptTimezone(entry);
        return kept ? [[userId, kept]] : [];
      }),
    );
  } catch {
    return {};
  }
}

/** Per account, the Keep its owner last answered on this device. */
export const keptTimezones = createStoredPreference<Record<string, KeptTimezone>>({
  key: "rakazo:kept-timezone",
  parse: parseKept,
  serialize: (kept) => (Object.keys(kept).length > 0 ? JSON.stringify(kept) : null),
});

export function keepTimezone(userId: string, kept: KeptTimezone): void {
  keptTimezones.set({ ...keptTimezones.get(), [userId]: kept });
}
