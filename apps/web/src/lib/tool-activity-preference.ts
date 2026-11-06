import { normalizeToolActivityPreference, TOOL_ACTIVITY_STORAGE_KEY } from "@rakazo/core";
import { createStoredPreference } from "./stored-preference";

export { TOOL_ACTIVITY_STORAGE_KEY };

/** Only a saved "on" shows tool cards. Missing or unreadable storage stays off so chats stay clean. */
export function normalizeToolActivityEnabled(raw: string | null | undefined): boolean {
  return normalizeToolActivityPreference(raw) === "on";
}

export const toolActivityPreference = createStoredPreference({
  key: TOOL_ACTIVITY_STORAGE_KEY,
  parse: normalizeToolActivityEnabled,
  serialize: (enabled) => (enabled ? "on" : "off"),
});
