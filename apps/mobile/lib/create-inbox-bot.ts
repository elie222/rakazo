import type { CreateBotInput } from "@rakazo/contracts";
import type { Href } from "expo-router";
import { captureApiRequestContext, selectedSpaceId, spaceSelectionSeq } from "./api";
import { allowFocusPrompt, scheduleFocusPrompt } from "./focus-prompt";
import { hapticSuccess } from "./haptics";
import { notifyInboxChanged } from "./inbox-changes";
import { askToAddModel } from "./model-settings";
import type { SaveSend } from "./query";
import { sendWith } from "./query";
import { addToSearchInbox, isSearchInboxSession, searchInboxSession } from "./search-inbox";

/**
 * Whether this would be the account's first bot, and whether that bot must wait for a model,
 * as in web onboarding, so it can greet the user. `modelSpaceId` is the space whose model
 * settings to open, when it overrides the account's.
 */
async function firstBotModelGate(spaceId: string | undefined, send: SaveSend) {
  // Authoritative roster so a slow home fetch does not treat later bots as first.
  // A failed list is unknown — use the delayed path rather than assuming first.
  const existing = await send("bots/list", undefined).catch(() => null);
  const isFirstBot = existing !== null && existing.length === 0;
  const needsModel = Boolean(
    isFirstBot && (await send("me", undefined).catch(() => null))?.needsModel,
  );
  const modelSpaceId =
    needsModel &&
    spaceId &&
    // Unknown overrides open the account's model settings rather than failing the create.
    (await send("spaceSettings/overrides", undefined).catch(() => null))?.includes("models")
      ? spaceId
      : undefined;
  return { isFirstBot, needsModel, modelSpaceId };
}

/** Where a request was asked from; it must not act after any account, server or Space switch. */
function askedHere() {
  const session = searchInboxSession();
  const space = selectedSpaceId();
  const selection = spaceSelectionSeq();
  return {
    session,
    unchanged: () =>
      isSearchInboxSession(session) &&
      spaceSelectionSeq() === selection &&
      selectedSpaceId() === space,
  };
}

/**
 * Asks for a model before the New bot screen is filled in, when the first bot would need one.
 * True when it asked; the screen then closes. `open` says whether the screen is still showing.
 */
export async function askForModelBeforeFirstBot(
  spaceId: string | undefined,
  open: () => boolean,
): Promise<boolean> {
  const asked = askedHere();
  const send = sendWith(spaceId ? await captureApiRequestContext(spaceId) : undefined);
  const gate = await firstBotModelGate(spaceId, send).catch(() => null);
  if (!gate?.needsModel || !asked.unchanged() || !open()) return false;
  askToAddModel(gate.modelSpaceId);
  return true;
}

/** `created` once the chat is opened; otherwise the screen has nothing left to do and closes. */
export type InboxBotOutcome = "created" | "needsModel" | "stale";

/**
 * Creates the bot named on the New bot screen, adds it to the search roster, and opens its chat.
 * Every request goes through `send`, the caller's save, which pins it to the bot's server,
 * session and Space; a spaceId names that Space when it is not the selected one.
 * The first bot waits for a model, as in web onboarding, so it can greet the user.
 * Throws when the bot could not be created.
 */
export async function createInboxBot({
  input,
  openChat,
  send,
  spaceId,
}: {
  input: Pick<CreateBotInput, "name" | "color" | "id" | "avatarFamily">;
  openChat: (href: Href) => void;
  send: SaveSend;
  spaceId?: string;
}): Promise<InboxBotOutcome> {
  // Taken before the requests, so a bot that lands after a session switch is dropped.
  const asked = askedHere();
  const askedIn = asked.session;
  const { isFirstBot, needsModel, modelSpaceId } = await firstBotModelGate(spaceId, send);
  // Create was asked for here; after any account, server or Space switch, even back, it does nothing.
  if (!asked.unchanged()) return "stale";
  if (needsModel) {
    askToAddModel(modelSpaceId);
    return "needsModel";
  }
  const bot = await send("bots/create", { ...input, notifyOnFinish: true });
  if (!isSearchInboxSession(askedIn)) return "stale";
  hapticSuccess();
  notifyInboxChanged();
  allowFocusPrompt(bot.id);
  addToSearchInbox({ kind: "bot", bot }, askedIn);
  openChat({
    pathname: "/thread",
    params: { botId: bot.id, name: bot.name, ...(spaceId ? { spaceId } : {}) },
  });
  void (async () => {
    const started = await send("onboarding/start", { botId: bot.id })
      .then(() => true)
      .catch(() => false);
    if (!started) return;
    scheduleFocusPrompt(bot.id, isFirstBot, send);
  })();
  return "created";
}
