import type { Href } from "expo-router";
import { captureApiRequestContext, rpc } from "./api";
import { allowFocusPrompt, scheduleFocusPrompt } from "./focus-prompt";
import { addToSearchInbox, searchInboxSession } from "./search-inbox";

/**
 * Creates a bot from the inbox's Create menu, adds it to the search roster, and opens its chat.
 * With a spaceId its requests are pinned to that space, whichever is selected.
 * Throws when the bot could not be created.
 */
export async function createInboxBot({
  refreshBots,
  openChat,
  spaceId,
}: {
  refreshBots: () => Promise<unknown>;
  openChat: (href: Href) => void;
  spaceId?: string;
}) {
  const options = spaceId ? { requestContext: await captureApiRequestContext(spaceId) } : undefined;
  // Taken before the requests, so a bot that lands after a session switch is dropped.
  const askedIn = searchInboxSession();
  // Authoritative roster so a slow home fetch does not treat later bots as first.
  // A failed list is unknown — use the delayed path rather than assuming first.
  const existing = await rpc("bots/list", undefined, options).catch(() => null);
  const isFirstBot = existing !== null && existing.length === 0;
  const bot = await rpc(
    "bots/create",
    { name: "New Bot", notifyOnFinish: true, computerMode: "team" },
    options,
  );
  void refreshBots().catch(() => undefined);
  allowFocusPrompt(bot.id);
  addToSearchInbox({ kind: "bot", bot }, askedIn);
  openChat({ pathname: "/thread", params: { botId: bot.id, name: bot.name } });
  void (async () => {
    const started = await rpc("onboarding/start", { botId: bot.id }, options)
      .then(() => true)
      .catch(() => false);
    if (!started) return;
    scheduleFocusPrompt(bot.id, isFirstBot);
  })();
}
