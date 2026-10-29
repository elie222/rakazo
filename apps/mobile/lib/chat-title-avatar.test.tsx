// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHAT_TITLE_AVATAR_SIZE, ChatTitleAvatar } from "../components/chat-title-avatar";
import type { MobileBot } from "./api";
import type { InboxSpace } from "./inbox-spaces";
import {
  addToSearchInbox,
  getSearchInbox,
  removeFromSearchInbox,
  searchInboxSession,
  setSearchInbox,
  useInboxBot,
} from "./search-inbox";

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({
    children,
    style,
  }: {
    children?: ReactNode;
    style?: { width?: number; backgroundColor?: string };
  }) =>
    createElement(
      "span",
      { "data-width": style?.width, "data-fill": style?.backgroundColor },
      children,
    ),
}));
vi.mock("../components/bot-avatar", () => ({
  BotAvatar: ({ color, size, muted }: { color: string; size: number; muted: boolean }) =>
    createElement("i", { "data-color": color, "data-size": size, "data-muted": String(muted) }),
}));
vi.mock("./native", () => ({ useThemedStyles: <T,>(factory: () => T) => factory() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ secondary: "secondary-fill" }) }));
vi.mock("./api", () => ({ currentApiBase: () => "http://api.test" }));
const session = vi.hoisted(() => ({ generation: 1 }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => session.generation,
  subscribeSessionGeneration: () => () => undefined,
}));

const helper = {
  id: "bot-1",
  name: "Helper",
  color: "#2A92FE::shape_2",
  notifyOnFinish: false,
  status: "idle",
  spaceId: "space-1",
} as MobileBot;
const space = (id: string, bots: unknown[], isDefault = false) =>
  ({ id, name: id, isDefault, hasContent: true, bots, groups: [] }) as unknown as InboxSpace;

let root: Root;
let container: HTMLDivElement;
/** How many times the title rendered, and whether each render had the avatar. */
let renders: boolean[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  session.generation = 1;
  renders = [];
  setSearchInbox([]);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

/** The chat title's avatar as the chat draws it: its own roster bot, else the inbox's. */
function Title({ rosterBot }: { rosterBot?: MobileBot }) {
  const inboxBot = useInboxBot("bot-1");
  const bot = rosterBot ?? inboxBot;
  renders.push(Boolean(bot));
  return <ChatTitleAvatar bot={bot} status={undefined} composing={false} />;
}
const render = (rosterBot?: MobileBot) => act(() => root.render(<Title rosterBot={rosterBot} />));
const avatar = () => container.querySelector("i");
const slot = () => container.querySelector("span");

it("draws the bot's avatar on the very first render when the inbox already loaded it", () => {
  setSearchInbox([space("space-1", [helper], true)]);
  render();
  expect(renders).toEqual([true]);
  expect(avatar()?.getAttribute("data-color")).toBe(helper.color);
  expect(avatar()?.getAttribute("data-size")).toBe(String(CHAT_TITLE_AVATAR_SIZE));
  expect(avatar()?.getAttribute("data-muted")).toBe("true");
});

it("holds the avatar's place at its final size until an unknown bot arrives", () => {
  render();
  expect(avatar()).toBeNull();
  expect(slot()?.getAttribute("data-width")).toBe(String(CHAT_TITLE_AVATAR_SIZE));
  // A plain circle in the shared grey fill, visible on the capsule in both themes.
  expect(slot()?.getAttribute("data-fill")).toBe("secondary-fill");
  act(() => setSearchInbox([space("space-1", [helper], true)]));
  expect(slot()).toBeNull();
  expect(avatar()?.getAttribute("data-size")).toBe(String(CHAT_TITLE_AVATAR_SIZE));
});

it("draws a just-created or archived bot that a screen added to the inbox roster", () => {
  setSearchInbox([space("space-1", [], true), space("space-2", [])]);
  addToSearchInbox({ kind: "bot", bot: { ...helper, spaceId: "space-2" } });
  render();
  expect(renders).toEqual([true]);
  expect(avatar()?.getAttribute("data-color")).toBe(helper.color);
});

it("replaces a bot already in the roster rather than listing it twice", () => {
  setSearchInbox([space("space-1", [helper], true)]);
  addToSearchInbox({ kind: "bot", bot: { ...helper, color: "#FF781C" } });
  render();
  expect(avatar()?.getAttribute("data-color")).toBe("#FF781C");
});

it("never makes a roster from one added bot, nor adds to another session's", () => {
  addToSearchInbox({ kind: "bot", bot: helper });
  render();
  expect(avatar()).toBeNull();
  act(() => root.unmount());
  setSearchInbox([space("space-1", [], true)]);
  session.generation = 2;
  addToSearchInbox({ kind: "bot", bot: helper });
  session.generation = 1;
  root = createRoot(container);
  render();
  expect(avatar()).toBeNull();
});

it("keeps an added bot through inbox refreshes that don't list it, as an archived bot's", () => {
  setSearchInbox([space("space-1", [], true)]);
  addToSearchInbox({ kind: "bot", bot: helper });
  render();
  act(() => setSearchInbox([space("space-1", [], true)]));
  act(() => setSearchInbox([space("space-1", [], true)]));
  expect(renders.every(Boolean)).toBe(true);
  expect(avatar()?.getAttribute("data-color")).toBe(helper.color);
});

it("drops an added bot once a refresh no longer lists its space", () => {
  setSearchInbox([space("space-1", [], true), space("space-2", [])]);
  addToSearchInbox({ kind: "bot", bot: { ...helper, spaceId: "space-2" } });
  render();
  expect(avatar()).not.toBeNull();
  // Its space was deleted: the bot must not fall back into the default space.
  act(() => setSearchInbox([space("space-1", [], true)]));
  expect(avatar()).toBeNull();
});

it("takes the inbox's own copy once it lists an added bot", () => {
  setSearchInbox([space("space-1", [], true)]);
  addToSearchInbox({ kind: "bot", bot: helper });
  render();
  act(() => setSearchInbox([space("space-1", [{ ...helper, color: "#FF781C" }], true)]));
  expect(avatar()?.getAttribute("data-color")).toBe("#FF781C");
  // Listed once, it is the inbox's to drop.
  act(() => setSearchInbox([space("space-1", [], true)]));
  expect(avatar()).toBeNull();
});

it("forgets added bots when the session changes", () => {
  setSearchInbox([space("space-1", [], true)]);
  addToSearchInbox({ kind: "bot", bot: helper });
  session.generation = 2;
  setSearchInbox([space("space-1", [], true)]);
  render();
  expect(avatar()).toBeNull();
  session.generation = 1;
});

it("drops a just-made bot that is archived or deleted before the inbox lists it", () => {
  setSearchInbox([space("space-1", [], true)]);
  addToSearchInbox({ kind: "bot", bot: helper });
  render();
  expect(avatar()).not.toBeNull();
  act(() => removeFromSearchInbox(helper.id));
  expect(avatar()).toBeNull();
  // The inbox's next list, which never had it, doesn't bring the added copy back.
  act(() => setSearchInbox([space("space-1", [], true)]));
  expect(avatar()).toBeNull();
  expect(getSearchInbox().flatMap((entry) => entry.bots)).toEqual([]);
});

it("takes an archived bot out of the inbox's own list too", () => {
  setSearchInbox([space("space-1", [helper], true)]);
  removeFromSearchInbox(helper.id);
  expect(getSearchInbox().flatMap((entry) => entry.bots)).toEqual([]);
});

it("drops a bot asked for in a session the app has since left", () => {
  setSearchInbox([space("space-1", [], true)]);
  const askedIn = searchInboxSession();
  session.generation = 2;
  setSearchInbox([space("space-1", [], true)]);
  addToSearchInbox({ kind: "bot", bot: helper }, askedIn);
  render();
  expect(avatar()).toBeNull();
  act(() => addToSearchInbox({ kind: "bot", bot: helper }, searchInboxSession()));
  expect(avatar()).not.toBeNull();
  session.generation = 1;
});
