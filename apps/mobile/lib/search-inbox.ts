import type { SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { useSyncExternalStore } from "react";
import type { MobileBot, MobileGroup } from "./api";
import { currentApiBase } from "./api";
import type { InboxSpace } from "./inbox-spaces";
import { currentSessionGeneration, subscribeSessionGeneration } from "./session";

const empty: readonly InboxSpace[] = [];
let snapshot = empty;
let generation = -1;
let apiBase = "";
const listeners = new Set<() => void>();

type InboxAddition = { kind: "bot"; bot: MobileBot } | { kind: "group"; group: MobileGroup };
// Bots and groups added before the inbox lists them (an archived bot never is). They outlast
// the inbox's refreshes so an open chat's title keeps them.
let additions: InboxAddition[] = [];

const additionId = (item: InboxAddition) => (item.kind === "bot" ? item.bot.id : item.group.id);
const additionSpaceId = (item: InboxAddition) =>
  item.kind === "bot" ? item.bot.spaceId : item.group.spaceId;

// Share the home roster without another request or navigation payload.
export function setSearchInbox(spaces: readonly InboxSpace[]): void {
  const sameSession = generation === currentSessionGeneration() && apiBase === currentApiBase();
  generation = currentSessionGeneration();
  apiBase = currentApiBase();
  const listed = new Set(
    spaces.flatMap((space) => [
      ...space.bots.map((bot) => bot.id),
      ...space.groups.map((group) => group.id),
    ]),
  );
  // An addition goes once the inbox lists it, or once its space is gone (a deleted space).
  const spaceIds = new Set(spaces.map((space) => space.id));
  additions =
    sameSession && spaces.length > 0
      ? additions.filter((item) => {
          const spaceId = additionSpaceId(item);
          return !listed.has(additionId(item)) && (!spaceId || spaceIds.has(spaceId));
        })
      : [];
  snapshot = additions.reduce(withAddition, spaces);
  for (const listener of listeners) listener();
}

export function getSearchInbox(): readonly InboxSpace[] {
  return generation === currentSessionGeneration() && apiBase === currentApiBase()
    ? snapshot
    : empty;
}

export function subscribeSearchInbox(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribe = subscribeSessionGeneration(listener);
  return () => {
    listeners.delete(listener);
    unsubscribe();
  };
}

/** The session and server a request started in, so its answer can be matched to them. */
export type SearchInboxSession = { generation: number; apiBase: string };

export function searchInboxSession(): SearchInboxSession {
  return { generation: currentSessionGeneration(), apiBase: currentApiBase() };
}

/**
 * Puts a bot or group the inbox doesn't list yet (just created, or an archived bot being
 * opened) into the shared roster, so the chat it opens can draw its title at once. It goes in
 * its own space, or the default one, replacing an entry with the same id, and stays through the
 * inbox's refreshes until the inbox lists it itself. With no roster yet, or one from another
 * session, it does nothing: one item never makes a roster. Pass the session the request
 * started in, so an answer that lands after a switch is dropped.
 */
export function addToSearchInbox(item: InboxAddition, askedIn?: SearchInboxSession): void {
  // A bot or group asked for in another session (another account or server) never joins this one.
  if (
    askedIn &&
    (askedIn.generation !== currentSessionGeneration() || askedIn.apiBase !== currentApiBase())
  )
    return;
  const current = getSearchInbox();
  if (current.length === 0) return;
  additions = [...additions.filter((kept) => additionId(kept) !== additionId(item)), item];
  snapshot = withAddition(current, item);
  for (const listener of listeners) listener();
}

/**
 * Takes an archived or deleted bot or group out of the shared roster at once, so neither its
 * added copy nor the inbox's last list keeps offering it before the inbox reloads.
 */
export function removeFromSearchInbox(id: string | undefined): void {
  if (!id) return;
  additions = additions.filter((item) => additionId(item) !== id);
  const current = getSearchInbox();
  if (!current.some((space) => [...space.bots, ...space.groups].some((chat) => chat.id === id))) {
    return;
  }
  snapshot = current.map((space) => ({
    ...space,
    bots: space.bots.filter((bot) => bot.id !== id),
    groups: space.groups.filter((group) => group.id !== id),
  }));
  for (const listener of listeners) listener();
}

function withAddition(spaces: readonly InboxSpace[], item: InboxAddition): readonly InboxSpace[] {
  const spaceId = additionSpaceId(item);
  const target =
    spaces.find((space) => space.id === spaceId) ??
    spaces.find((space) => space.isDefault) ??
    spaces[0]!;
  return spaces.map((space) => {
    if (space !== target) return space;
    if (item.kind === "bot") {
      const bots = space.bots.filter((bot) => bot.id !== item.bot.id);
      return { ...space, bots: [...bots, item.bot] };
    }
    const groups = space.groups.filter((group) => group.id !== item.group.id);
    return { ...space, groups: [...groups, item.group] };
  });
}

/**
 * A bot as the inbox last loaded it, for a chat that opens before its own roster arrives: its
 * title can draw the avatar on the first frame.
 */
export function useInboxBot(botId: string | undefined): MobileBot | SpaceBot | undefined {
  const spaces = useSyncExternalStore(subscribeSearchInbox, getSearchInbox, getSearchInbox);
  if (!botId) return undefined;
  for (const space of spaces) {
    const bot = space.bots.find((candidate) => candidate.id === botId);
    if (bot) return bot;
  }
  return undefined;
}

/**
 * A group as the inbox last loaded it, for a group chat that opens before its own members
 * arrive: its title can seat them on the first frame.
 */
export function useInboxGroup(groupId: string | undefined): MobileGroup | SpaceGroup | undefined {
  const spaces = useSyncExternalStore(subscribeSearchInbox, getSearchInbox, getSearchInbox);
  if (!groupId) return undefined;
  for (const space of spaces) {
    const group = space.groups.find((candidate) => candidate.id === groupId);
    if (group) return group;
  }
  return undefined;
}
