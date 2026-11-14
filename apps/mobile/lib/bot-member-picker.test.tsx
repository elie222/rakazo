// @vitest-environment jsdom

import { GROUP_MEMBER_MAX } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GroupSettings from "../app/group-settings";
import { BotMemberPicker } from "../components/bot-member-picker";
import { notifyArchivedChatsChanged } from "./archived-chats";
import type { MobileBot, MobileGroup } from "./mobile-types";

const { rpc, back, push, replace } = vi.hoisted(() => ({
  rpc: vi.fn(),
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./session", () => ({ currentSessionGeneration: () => 0 }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
const space = vi.hoisted(() => ({ id: "space-a" }));
vi.mock("./api", () => ({ rpc, selectedSpaceId: () => space.id }));
vi.mock("./search-inbox", () => ({ removeFromSearchInbox: vi.fn() }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back, push, replace }),
  useLocalSearchParams: () => ({ groupId: "group-1" }),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Pressable: ({
      children,
      onPress,
      disabled,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      onPress: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
    }) => (
      <button type="button" onClick={onPress} disabled={disabled} aria-label={accessibilityLabel}>
        {children}
      </button>
    ),
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
      placeholder,
    }: {
      value: string;
      onChangeText: (value: string) => void;
      accessibilityLabel?: string;
      placeholder?: string;
    }) => (
      <input
        value={value}
        onChange={(event) => onChangeText(event.target.value)}
        aria-label={accessibilityLabel}
        placeholder={placeholder}
      />
    ),
    StyleSheet: { create: (styles: unknown) => styles },
    Alert: { alert: vi.fn() },
  };
});
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    value,
    onValueChange,
    disabled,
    accessibilityLabel,
  }: {
    value: boolean;
    onValueChange: (next: boolean) => void;
    disabled: boolean;
    accessibilityLabel: string;
  }) => (
    <input
      type="checkbox"
      checked={value}
      onChange={(event) => onValueChange(event.target.checked)}
      disabled={disabled}
      aria-label={accessibilityLabel}
    />
  ),
}));

const bots = [
  { id: "bot-1", name: "Researcher" },
  { id: "bot-2", name: "Writer" },
  { id: "bot-3", name: "Runner" },
] as MobileBot[];
const group = {
  id: "group-1",
  name: "Team",
  members: [{ botId: "bot-1" }, { botId: "bot-2" }],
} as MobileGroup;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  space.id = "space-a";
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "groups/list"
      ? [group]
      : procedure === "bots/list"
        ? bots
        : procedure === "bots/listArchived"
          ? []
          : undefined,
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function switches() {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function filter(query: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Filter bots"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("loads members before mounting the collapsed picker and saves reversible edits", async () => {
  await act(async () => root.render(<GroupSettings />));
  expect(switches().map((input) => input.getAttribute("aria-label"))).toEqual([
    "Researcher",
    "Writer",
  ]);
  await act(async () => switches()[1]!.click());
  expect(switches()).toHaveLength(2);
  await act(async () => switches()[1]!.click());
  await click("Show all");
  await filter("  RESEARCH ");
  expect(switches()).toHaveLength(1);
  await filter("zzz");
  expect(container.textContent).toContain("No matching bots");
  await click("Show selected");
  expect(switches()).toHaveLength(2);
  await click("Show all");
  await filter("");
  await act(async () => switches()[2]!.click());
  await click("Show selected");
  expect(switches()).toHaveLength(3);
  await click("Save");
  expect(rpc).toHaveBeenCalledWith("groups/update", {
    groupId: "group-1",
    botIds: ["bot-1", "bot-2", "bot-3"],
    expectedBotIds: ["bot-1", "bot-2"],
  });
  expect(back).toHaveBeenCalledOnce();
});

it("limits additions while still allowing members to be removed", async () => {
  const roster = Array.from({ length: GROUP_MEMBER_MAX + 1 }, (_, index) => ({
    ...bots[0],
    id: `bot-${index}`,
    name: `Bot ${index}`,
  })) as MobileBot[];
  function Picker() {
    const [selected, setSelected] = useState(
      roster.slice(0, GROUP_MEMBER_MAX).map((bot) => bot.id),
    );
    return (
      <BotMemberPicker bots={roster} selected={selected} onChange={setSelected} initiallyExpanded />
    );
  }
  await act(async () => root.render(<Picker />));
  expect(switches().at(-1)?.disabled).toBe(true);
  expect(switches()[0]?.disabled).toBe(false);
  await act(async () => switches()[0]!.click());
  expect(switches().at(-1)?.disabled).toBe(false);
});

function openButtons() {
  return [...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")];
}

it("opens a member's profile from group settings without touching membership", async () => {
  await act(async () => root.render(<GroupSettings />));
  expect(openButtons().map((button) => button.getAttribute("aria-label"))).toEqual([
    "Researcher",
    "Writer",
  ]);
  await act(async () => switches()[1]!.click());
  expect(push).not.toHaveBeenCalled();
  await act(async () => openButtons()[0]!.click());
  expect(push).toHaveBeenCalledExactlyOnceWith({
    pathname: "/bot-profile",
    params: { botId: "bot-1", name: "Researcher" },
  });
  // The member edit made before opening the profile is still there to save.
  expect(switches().map((input) => input.checked)).toEqual([true, false]);
});

it("keeps members closed while a save is running", async () => {
  let finish = () => {};
  rpc.mockImplementation((procedure: string) =>
    procedure === "groups/update"
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(
          procedure === "groups/list"
            ? [group]
            : procedure === "bots/list"
              ? bots
              : procedure === "bots/listArchived"
                ? []
                : undefined,
        ),
  );
  await act(async () => root.render(<GroupSettings />));
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[placeholder="Group name"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Crew");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save");
  expect(rpc).toHaveBeenCalledWith("groups/update", { groupId: "group-1", name: "Crew" });
  expect(openButtons()).toHaveLength(2);
  expect(openButtons().every((button) => button.disabled)).toBe(true);
  await act(async () => finish());
});

it("removes deleted bots from an open group picker after deletion completes", async () => {
  await act(async () => root.render(<GroupSettings />));
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "groups/list"
      ? [{ ...group, members: group.members.slice(1) }]
      : procedure === "bots/list"
        ? bots.slice(1)
        : procedure === "bots/listArchived"
          ? []
          : undefined,
  );
  await act(async () => notifyArchivedChatsChanged());
  expect(switches().map((input) => input.getAttribute("aria-label"))).toEqual(["Writer"]);
  await click("Show all");
  expect(switches().map((input) => input.getAttribute("aria-label"))).toEqual(["Writer", "Runner"]);
});

it("preserves archived membership when the bot is restored", async () => {
  await act(async () => root.render(<GroupSettings />));
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "groups/list"
      ? [group]
      : procedure === "bots/list"
        ? bots.slice(1)
        : procedure === "bots/listArchived"
          ? [bots[0]]
          : undefined,
  );
  await act(async () => notifyArchivedChatsChanged());
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "groups/list"
      ? [group]
      : procedure === "bots/list"
        ? bots
        : procedure === "bots/listArchived"
          ? []
          : undefined,
  );
  await act(async () => notifyArchivedChatsChanged());
  expect(switches().map((input) => input.getAttribute("aria-label"))).toEqual([
    "Researcher",
    "Writer",
  ]);
});

it("ignores an older refresh after a deletion refresh completes", async () => {
  await act(async () => root.render(<GroupSettings />));
  let resolveOld!: (value: MobileBot[]) => void;
  const old = new Promise<MobileBot[]>((resolve) => {
    resolveOld = resolve;
  });
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "groups/list" ? [group] : procedure === "bots/list" ? old : [],
  );
  await act(async () => notifyArchivedChatsChanged());
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "groups/list"
      ? [{ ...group, members: group.members.slice(1) }]
      : procedure === "bots/list"
        ? bots.slice(1)
        : [],
  );
  await act(async () => notifyArchivedChatsChanged());
  await act(async () => resolveOld(bots));
  expect(switches().map((input) => input.getAttribute("aria-label"))).toEqual(["Writer"]);
});

it("shows refreshed members while collapsed and adopts an unedited server rename", async () => {
  await act(async () => root.render(<GroupSettings />));
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "groups/list"
      ? [{ ...group, name: "Renamed", members: bots.map((bot) => ({ botId: bot.id })) }]
      : procedure === "bots/list"
        ? bots
        : [],
  );
  await act(async () => notifyArchivedChatsChanged());
  expect(switches().map((input) => input.getAttribute("aria-label"))).toEqual([
    "Researcher",
    "Writer",
    "Runner",
  ]);
  await act(async () => switches()[2]!.click());
  expect(switches()).toHaveLength(3);
  await act(async () => switches()[2]!.click());
  await click("Save");
  expect(rpc).not.toHaveBeenCalledWith("groups/update", expect.anything());
});

it("does not overwrite a refreshed member order when saving", async () => {
  await act(async () => root.render(<GroupSettings />));
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "groups/list"
      ? [{ ...group, members: [...group.members].reverse() }]
      : procedure === "bots/list"
        ? bots
        : [],
  );
  await act(async () => notifyArchivedChatsChanged());
  await click("Save");
  expect(rpc).not.toHaveBeenCalledWith("groups/update", expect.anything());
});

it("keeps a failed save visible after a successful refresh", async () => {
  await act(async () => root.render(<GroupSettings />));
  await click("Show all");
  await act(async () => switches()[2]!.click());
  rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "groups/update") throw new Error("Save failed");
    return procedure === "groups/list" ? [group] : procedure === "bots/list" ? bots : [];
  });
  await click("Save");
  const before = container.textContent;
  await act(async () => notifyArchivedChatsChanged());
  expect(container.textContent).toBe(before);
});

it("does not refresh an open group from another selected Space", async () => {
  await act(async () => root.render(<GroupSettings />));
  rpc.mockClear();
  space.id = "space-b";
  await act(async () => notifyArchivedChatsChanged());
  expect(rpc).not.toHaveBeenCalled();
  expect(switches()).toHaveLength(2);
});

it("preserves a local deselection across remote removal and readdition", async () => {
  await act(async () => root.render(<GroupSettings />));
  await act(async () => switches()[1]!.click());
  let members = group.members.slice(0, 1);
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "groups/list" ? [{ ...group, members }] : procedure === "bots/list" ? bots : [],
  );
  await act(async () => notifyArchivedChatsChanged());
  members = group.members;
  await act(async () => notifyArchivedChatsChanged());
  expect(switches()[1]!.checked).toBe(false);
});
