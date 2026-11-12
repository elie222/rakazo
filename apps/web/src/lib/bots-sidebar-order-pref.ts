import { createStoredPreference } from "./stored-preference";

/** Sections keeps the user's own layout; activity lists every chat newest first. */
export type BotsSidebarOrder = "sections" | "activity";

export const BOTS_SIDEBAR_ORDER_STORAGE_KEY = "rakazo.botsSidebarOrder";

export function normalizeBotsSidebarOrder(raw: string | null | undefined): BotsSidebarOrder {
  return raw?.trim().toLowerCase() === "activity" ? "activity" : "sections";
}

export const botsSidebarOrderPreference = createStoredPreference<BotsSidebarOrder>({
  key: BOTS_SIDEBAR_ORDER_STORAGE_KEY,
  parse: normalizeBotsSidebarOrder,
  serialize: normalizeBotsSidebarOrder,
});
