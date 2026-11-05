import type { Href } from "expo-router";
import { rpc, selectedSpaceId, spaceSelectionSeq } from "./api";
import { allowFocusPrompt, scheduleFocusPrompt } from "./focus-prompt";
import { askToAddModel } from "./model-settings";
import { addToSearchInbox, isSearchInboxSession, searchInboxSession } from "./search-inbox";

/**
 * Creates a bot from the inbox's Create menu, adds it to the search roster, and opens its chat.
 * The first bot waits for a model, as in web onboarding, so it can greet the user.
 * Throws when the bot could not be created.
 */
export async function createInboxBot({
  refreshBots,
  openChat,
}: {
  refreshBots: () => Promise<unknown>;
  openChat: (href: Href) => void;
}) {
  // Taken before the requests, so a bot that lands after a session switch is dropped.
  const askedIn = searchInboxSession();
  const spaceId = selectedSpaceId();
  const spaceSelection = spaceSelectionSeq();
  // Authoritative roster so a slow home fetch does not treat later bots as first.
  // A failed list is unknown — use the delayed path rather than assuming first.
  const existing = await rpc("bots/list").catch(() => null);
  const isFirstBot = existing !== null && existing.length === 0;
  const needsModel = isFirstBot && (await rpc("me").catch(() => null))?.needsModel;
  // Create was asked for here; after any account, server or Space switch, even back, it does nothing.
  const moved = spaceSelectionSeq() !== spaceSelection || selectedSpaceId() !== spaceId;
  if (!isSearchInboxSession(askedIn) || moved) return;
  if (needsModel) {
    askToAddModel();
    return;
  }
  const bot = await rpc("bots/create", {
    name: "New Bot",
    notifyOnFinish: true,
    computerMode: "team",
  });
  void refreshBots().catch(() => undefined);
  allowFocusPrompt(bot.id);
  addToSearchInbox({ kind: "bot", bot }, askedIn);
  openChat({ pathname: "/thread", params: { botId: bot.id, name: bot.name } });
  void (async () => {
    const started = await rpc("onboarding/start", { botId: bot.id })
      .then(() => true)
      .catch(() => false);
    if (!started) return;
    scheduleFocusPrompt(bot.id, isFirstBot);
  })();
}
