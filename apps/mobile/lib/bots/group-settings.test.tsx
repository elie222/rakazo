// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GroupSettingsScreen from "../../app/group-settings";
import { queryClient } from "../query/query";

const { announce } = vi.hoisted(() => ({ announce: vi.fn() }));
const { rpc, router, alert, selection, archivedListeners, params } = vi.hoisted(() => ({
  params: { groupId: "group-1" },
  rpc: vi.fn(),
  router: { back: vi.fn(), replace: vi.fn(), push: vi.fn() },
  alert: vi.fn(),
  selection: { spaceId: "space-1" },
  archivedListeners: new Set<() => void>(),
}));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../api/api", () => ({
  rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => selection.spaceId,
  captureApiRequestContext: async (spaceId: string | null = selection.spaceId) => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../search/search-inbox", () => ({ removeFromSearchInbox: vi.fn() }));
vi.mock("../inbox/archived/archived-chats", () => ({
  notifyArchivedChatsChanged: () => {
    for (const listener of archivedListeners) listener();
  },
  onArchivedChatsChanged: (listener: () => void) => {
    archivedListeners.add(listener);
    return () => archivedListeners.delete(listener);
  },
}));
vi.mock("../native/native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("../native/announce", () => ({ announceToScreenReader: announce }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => params,
  useRouter: () => router,
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: { alert },
    ScrollView: View,
    Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    TextInput: ({
      value,
      onChangeText,
    }: {
      value: string;
      onChangeText: (value: string) => void;
    }) => <input value={value} onChange={(event) => onChangeText(event.target.value)} />,
  };
});
vi.mock("../../components/native/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("../../components/bots/bot-member-picker", () => ({
  BotMemberPicker: ({ selected, disabled }: { selected: string[]; disabled?: boolean }) => (
    <output data-disabled={String(Boolean(disabled))}>{selected.join(",")}</output>
  ),
}));
vi.mock("../../components/native/native-action-button", () => ({
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
// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

const group = {
  id: "group-1",
  name: "Team",
  members: [{ botId: "bot-1" }, { botId: "bot-2" }],
};
const otherGroup = {
  id: "group-2",
  name: "Crew",
  members: [{ botId: "bot-1" }, { botId: "bot-3" }],
};
const bots = [
  { id: "bot-1", name: "Ada" },
  { id: "bot-2", name: "Bo" },
  { id: "bot-3", name: "Cy" },
];
let root: Root;
let container: HTMLDivElement;
let write: Deferred<unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  archivedListeners.clear();
  selection.spaceId = "space-1";
  params.groupId = "group-1";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  write = deferred();
  rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "groups/list") return [group, otherGroup];
    if (procedure === "bots/list") return bots;
    return write.promise;
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label);
const writes = (procedure: string) => rpc.mock.calls.filter(([called]) => called === procedure);
async function rename(value: string) {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("saves once on a double tap to the group's Space, holds the form, then goes back", async () => {
  await act(async () => root.render(<GroupSettingsScreen />));
  expect(container.querySelector("output")!.textContent).toBe("bot-1,bot-2");
  await rename("Crew");
  // Another Space selected meanwhile: the group still saves where it lives.
  selection.spaceId = "space-2";
  await act(async () => {
    button("Save")!.click();
    button("Save")!.click();
  });
  expect(writes("groups/update")).toEqual([
    [
      "groups/update",
      { groupId: "group-1", name: "Crew" },
      { requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-1" } }) },
    ],
  ]);
  expect(button("Saving…")!.disabled).toBe(true);
  expect(container.querySelector("output")!.dataset.disabled).toBe("true");
  await act(async () => write.resolve({}));
  expect(router.back).toHaveBeenCalledOnce();
});

it("shows a failed save and offers Save again", async () => {
  await act(async () => root.render(<GroupSettingsScreen />));
  await rename("Crew");
  await act(async () => button("Save")!.click());
  await act(async () => write.reject(new Error("Name taken")));
  expect(container.textContent).toContain("Name taken");
  expect(announce).toHaveBeenCalledExactlyOnceWith("Name taken");
  expect(button("Save")!.disabled).toBe(false);
  expect(router.back).not.toHaveBeenCalled();
});

it("keeps an edited name when the group is read again", async () => {
  await act(async () => root.render(<GroupSettingsScreen />));
  await rename("Crew");
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "groups/list" ? [{ ...group, name: "Team 2" }] : bots,
  );
  await act(async () => {
    for (const listener of archivedListeners) listener();
  });
  expect(container.querySelector("input")!.value).toBe("Crew");
});

it("starts from the new group's own values when another group opens in place", async () => {
  await act(async () => root.render(<GroupSettingsScreen />));
  await rename("Renamed");
  params.groupId = "group-2";
  await act(async () => root.render(<GroupSettingsScreen />));
  expect(container.querySelector("input")!.value).toBe("Crew");
  expect(container.querySelector("output")!.textContent).toBe("bot-1,bot-3");
  await act(async () => button("Save")!.click());
  expect(writes("groups/update")).toHaveLength(0);
});

it("deletes after confirming and leaves for the inbox, or alerts why not", async () => {
  await act(async () => root.render(<GroupSettingsScreen />));
  await act(async () => button("Delete group")!.click());
  expect(writes("groups/remove")).toHaveLength(0);
  const confirm = alert.mock.lastCall![2][1] as { onPress: () => void };
  await act(async () => confirm.onPress());
  expect(writes("groups/remove")).toEqual([
    ["groups/remove", { groupId: "group-1" }, expect.anything()],
  ]);
  await act(async () => write.reject(new Error("Offline")));
  expect(alert).toHaveBeenLastCalledWith("Could not delete group", "Offline");
  expect(router.replace).not.toHaveBeenCalled();

  write = deferred();
  await act(async () => button("Delete group")!.click());
  await act(async () => (alert.mock.lastCall![2][1] as { onPress: () => void }).onPress());
  await act(async () => write.resolve({ ok: true }));
  expect(router.replace).toHaveBeenCalledWith("/");
});

it("says when the group is gone", async () => {
  rpc.mockImplementation(async (procedure: string) => (procedure === "groups/list" ? [] : bots));
  await act(async () => root.render(<GroupSettingsScreen />));
  expect(container.textContent).toContain("Group not found");
});

it("announces each failed save, and a repeat of the same failure again", async () => {
  await act(async () => root.render(<GroupSettingsScreen />));
  await rename("Crew");
  await act(async () => button("Save")!.click());
  expect(announce).not.toHaveBeenCalled();
  await act(async () => write.reject(new Error("Name taken")));
  expect(announce).toHaveBeenCalledExactlyOnceWith("Name taken");

  write = deferred();
  await act(async () => button("Save")!.click());
  await act(async () => write.reject(new Error("Name taken")));
  expect(announce).toHaveBeenCalledTimes(2);
  expect(announce).toHaveBeenLastCalledWith("Name taken");
});

it("announces a failed load once, when it appears", async () => {
  rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "groups/list") throw new Error("Groups are unavailable");
    return bots;
  });
  await act(async () => root.render(<GroupSettingsScreen />));
  expect(container.textContent).toContain("Groups are unavailable");
  expect(announce).toHaveBeenCalledExactlyOnceWith("Groups are unavailable");
});
