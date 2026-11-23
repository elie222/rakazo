export const COMPOSER_ENTER_TO_SEND_STORAGE_KEY = "rakazo.composerEnterToSend";

/** A null result leaves Enter behavior up to the device's keyboard default. */
export function parseComposerEnterToSend(raw: string | null): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  return null;
}

export function serializeComposerEnterToSend(enabled: boolean): string {
  return enabled ? "1" : "0";
}
