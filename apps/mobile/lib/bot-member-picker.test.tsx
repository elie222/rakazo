// @vitest-environment jsdom

import { GROUP_MEMBER_MAX } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GroupSettings from "../app/group-settings";
import NewGroup from "../app/new-group";
import { BotMemberPicker } from "../components/bot-member-picker";
import type { MobileBot, MobileGroup } from "./api";

const { rpc, back, replace } = vi.hoisted(() => ({
  rpc: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("./api", () => ({ rpc }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back, replace }),
  useLocalSearchParams: () => ({ groupId: "group-1" }),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
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
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values: Record<string, string | number> = {}) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key])),
  }),
}));
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
  { id: "bot-1", name: "Researcher", title: "Reads papers" },
  { id: "bot-2", name: "Writer", title: "Drafts prose" },
  { id: "bot-3", name: "Runner", title: "Runs tasks" },
] as MobileBot[];
const group = {
  id: "group-1",
  name: "Team",
  members: [{ botId: "bot-1" }, { botId: "bot-2" }],
} as MobileGroup;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "groups/list" ? [group] : procedure === "bots/list" ? bots : undefined,
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
  await filter("  PAPERS ");
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
  });
  expect(back).toHaveBeenCalledOnce();
});

it("starts new groups with the roster expanded and excludes archived bots", async () => {
  rpc.mockResolvedValue([...bots, { ...bots[0], id: "archived", archivedAt: "2026-01-01" }]);
  await act(async () => root.render(<NewGroup />));
  expect(container.querySelector('[aria-label="Filter bots"]')).not.toBeNull();
  expect(switches()).toHaveLength(3);
  await filter("prose");
  expect(switches()[0]?.getAttribute("aria-label")).toBe("Writer");
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
