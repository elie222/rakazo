// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishChatTitle } from "../components/chat-header-title";
import { useThreadHeader } from "../components/thread/thread-header";
import type { MobileGroup } from "./api";
import type { InboxSpace } from "./inbox-spaces";
import { addToSearchInbox, setSearchInbox, useInboxGroup } from "./search-inbox";
import { threadGroupMembers } from "./thread-snapshot";

vi.mock("./api", () => ({ currentApiBase: () => "http://api.test" }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => 1,
  subscribeSessionGeneration: () => () => undefined,
}));
vi.mock("expo-router", () => ({
  useNavigation: () => ({ setOptions: vi.fn() }),
  useRoute: () => ({ key: "route-1" }),
  useRouter: () => ({}),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("../components/chat-header-title", () => ({ publishChatTitle: vi.fn(() => () => {}) }));
vi.mock("../components/sheet-header", () => ({ trailingHeaderOptions: () => ({}) }));
vi.mock("../components/thread-header-right", () => ({ threadHeaderRight: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./archived-chats", () => ({ notifyArchivedChatsChanged: vi.fn() }));
vi.mock("./bot-lifecycle", () => ({}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("./native", () => ({ useResolvedAppearance: () => "light" }));
vi.mock("./thread-edges", () => ({ threadEdgeOptions: () => ({}) }));
vi.mock("./user-error", () => ({ errorText: String }));

const members = [
  { botId: "bot-2", name: "Scout", color: "#3B82F6::shape_1" },
  { botId: "bot-1", name: "Chief", color: "#F97316::shape_0" },
];
const space = {
  id: "space-1",
  name: "Personal",
  isDefault: true,
  hasContent: true,
  bots: [],
  groups: [{ id: "group-1", name: "Duo", members }],
} as unknown as InboxSpace;

let root: Root;
let container: HTMLDivElement;
let seen: unknown;
function Probe({ groupId }: { groupId: string }) {
  seen = useInboxGroup(groupId)?.members;
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setSearchInbox([]);
  seen = undefined;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("has a group's members, in its order, as soon as the inbox has loaded it", () => {
  setSearchInbox([space]);
  act(() => root.render(<Probe groupId="group-1" />));
  expect(seen).toBe(members);
  act(() => root.render(<Probe groupId="group-2" />));
  expect(seen).toBeUndefined();
});

it("seats a group that opens before the inbox knows it once the inbox loads", () => {
  act(() => root.render(<Probe groupId="group-1" />));
  expect(seen).toBeUndefined();
  act(() => setSearchInbox([space]));
  expect(seen).toBe(members);
});

it("seats a just-created group the inbox doesn't list yet once its screen adds it", () => {
  setSearchInbox([space]);
  act(() => root.render(<Probe groupId="group-new" />));
  expect(seen).toBeUndefined();
  const created = {
    id: "group-new",
    spaceId: "space-1",
    name: "New",
    members,
  } as unknown as MobileGroup;
  act(() => addToSearchInbox({ kind: "group", group: created }));
  expect(seen).toBe(members);
});

it("keeps seating a just-created group through an inbox refresh that predates it", () => {
  setSearchInbox([space]);
  const created = {
    id: "group-new",
    spaceId: "space-1",
    name: "New",
    members,
  } as unknown as MobileGroup;
  addToSearchInbox({ kind: "group", group: created });
  act(() => root.render(<Probe groupId="group-new" />));
  act(() => setSearchInbox([space]));
  expect(seen).toBe(members);
});

it("seats the members the chat loads, then its group list's, only in a group", () => {
  const loaded = members.slice(1);
  const groups = [{ id: "group-1", members }];
  expect(threadGroupMembers("group-1", { members: loaded }, groups)).toBe(loaded);
  expect(threadGroupMembers("group-1", null, groups)).toBe(members);
  expect(threadGroupMembers("group-2", null, groups)).toBeUndefined();
  expect(threadGroupMembers(undefined, { members: loaded }, groups)).toBeUndefined();
});

it("publishes the members the chat loads to its title", () => {
  function Header() {
    useThreadHeader({
      groupId: "group-1",
      inGroup: true,
      readOnly: false,
      displayName: "Duo",
      titleName: "Duo",
      groupMembers: members,
      composingBots: "",
      styles: {} as Parameters<typeof useThreadHeader>[0]["styles"],
      onCleared: vi.fn(),
    });
    return null;
  }
  act(() => root.render(<Header />));
  expect(publishChatTitle).toHaveBeenLastCalledWith(
    "route-1",
    expect.objectContaining({ name: "Duo", members }),
  );
});
