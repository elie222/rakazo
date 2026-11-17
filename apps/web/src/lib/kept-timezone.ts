import { createStoredPreference } from "./stored-preference";

function parseKept(raw: string | null): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** Per account, the device zone its owner chose on this device to keep the account's zone for. */
export const keptTimezones = createStoredPreference<Record<string, string>>({
  key: "rakazo:kept-timezone",
  parse: parseKept,
  serialize: (kept) => (Object.keys(kept).length > 0 ? JSON.stringify(kept) : null),
});

export function keepTimezone(userId: string, deviceZone: string): void {
  keptTimezones.set({ ...keptTimezones.get(), [userId]: deviceZone });
}
