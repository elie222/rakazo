import type { CreateBotInput } from "@rakazo/contracts";
import type { Href } from "expo-router";
import { captureApiRequestContext, rpc, selectedSpaceId, spaceSelectionSeq } from "./api";
import { allowFocusPrompt, scheduleFocusPrompt } from "./focus-prompt";
import { hapticSuccess } from "./haptics";
import { notifyInboxChanged } from "./inbox-changes";
import { askToAddModel } from "./model-settings";
import { addToSearchInbox, isSearchInboxSession, searchInboxSession } from "./search-inbox";

type RequestOptions = { requestContext: Awaited<ReturnType<typeof captureApiRequestContext>> };

async function requestOptions(spaceId?: string): Promise<RequestOptions | undefined> {
  return spaceId ? { requestContext: await captureApiRequestContext(spaceId) } : undefined;
}

/**
 * Whether this would be the account's first bot, and whether that bot must wait for a model,
 * as in web onboarding, so it can greet the user. `modelSpaceId` is the space whose model
 * settings to open, when it overrides the account's.
 */
async function firstBotModelGate(spaceId: string | undefined, options?: RequestOptions) {
  // Authoritative roster so a slow home fetch does not treat later bots as first.
  // A failed list is unknown — use the delayed path rather than assuming first.
  const existing = await rpc("bots/list", undefined, options).catch(() => null);
  const isFirstBot = existing !== null && existing.length === 0;
  const needsModel = Boolean(
    isFirstBot && (await rpc("me", undefined, options).catch(() => null))?.needsModel,
  );
  const modelSpaceId =
    needsModel &&
    spaceId &&
    (await rpc("spaceSettings/overrides", undefined, options)).includes("models")
      ? spaceId
      : undefined;
  return { isFirstBot, needsModel, modelSpaceId };
}

/**
 * Asks for a model before the New bot screen is filled in, when the first bot would need one.
 * True when it asked; the screen then closes.
 */
export async function askForModelBeforeFirstBot(spaceId?: string): Promise<boolean> {
  const askedIn = searchInboxSession();
  const gate = await firstBotModelGate(spaceId, await requestOptions(spaceId)).catch(() => null);
  if (!gate?.needsModel || !isSearchInboxSession(askedIn)) return false;
  askToAddModel(gate.modelSpaceId);
  return true;
}

/** `created` once the chat is opened; otherwise the screen has nothing left to do and closes. */
export type InboxBotOutcome = "created" | "needsModel" | "stale";

/**
 * Creates the bot named on the New bot screen, adds it to the search roster, and opens its chat.
 * With a spaceId its requests are pinned to that space, whichever is selected.
 * The first bot waits for a model, as in web onboarding, so it can greet the user.
 * Throws when the bot could not be created.
 */
export async function createInboxBot({
  input,
  openChat,
  spaceId,
}: {
  input: Pick<CreateBotInput, "name" | "color" | "id" | "avatarFamily">;
  openChat: (href: Href) => void;
  spaceId?: string;
}): Promise<InboxBotOutcome> {
  // Taken before the requests, so a bot that lands after a session switch is dropped.
  const askedIn = searchInboxSession();
  const selectedSpace = selectedSpaceId();
  const spaceSelection = spaceSelectionSeq();
  const options = await requestOptions(spaceId);
  const { isFirstBot, needsModel, modelSpaceId } = await firstBotModelGate(spaceId, options);
  // Create was asked for here; after any account, server or Space switch, even back, it does nothing.
  const moved = spaceSelectionSeq() !== spaceSelection || selectedSpaceId() !== selectedSpace;
  if (!isSearchInboxSession(askedIn) || moved) return "stale";
  if (needsModel) {
    askToAddModel(modelSpaceId);
    return "needsModel";
  }
  const bot = await rpc(
    "bots/create",
    { ...input, notifyOnFinish: true, computerMode: "team" },
    options,
  );
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
    const started = await rpc("onboarding/start", { botId: bot.id }, options)
      .then(() => true)
      .catch(() => false);
    if (!started) return;
    scheduleFocusPrompt(bot.id, isFirstBot, options?.requestContext);
  })();
  return "created";
}
