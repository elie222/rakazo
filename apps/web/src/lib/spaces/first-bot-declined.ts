const KEY = "rakazo:first-bot-declined";

function read(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Onboarding asked the server for this Space's first bot and was told none is due, because the
 * person has chatted elsewhere. The empty Space then stays in the app instead of being sent back
 * to onboarding, which would only answer the same again. Kept for the tab's session.
 */
export function rememberFirstBotDeclined(spaceId: string | null) {
  if (!spaceId) return;
  try {
    const ids = read();
    if (!ids.includes(spaceId))
      window.sessionStorage.setItem(KEY, JSON.stringify([...ids, spaceId]));
  } catch {
    // Without storage the Space passes through onboarding again, which still lands here.
  }
}

export function firstBotDeclined(spaceId: string | null | undefined): boolean {
  return Boolean(spaceId) && read().includes(spaceId!);
}
