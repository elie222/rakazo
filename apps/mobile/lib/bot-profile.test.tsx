// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Routine } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ArtifactsScreen from "../app/artifacts";
import BotProfile from "../app/bot-profile";
import RoutineDetail from "../app/routine";
import type * as RoutineHelpers from "./routine";

const { rpc, push, listSpaceArtifacts, params, color } = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  listSpaceArtifacts: vi.fn(),
  params: { current: {} as Record<string, string> },
  color: new Proxy({}, { get: (_, key) => String(key) }),
}));

vi.mock("./api", () => ({ rpc }));
vi.mock("./artifacts", () => ({
  listSpaceArtifacts,
  matchesArtifactQuery: () => true,
  mimeBadgeLabel: () => "",
  removeArtifact: vi.fn(),
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push }),
  useNavigation: () => ({ setOptions: vi.fn() }),
  useLocalSearchParams: () => params.current,
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ fontScale: 1, width: 390 }),
    ActivityIndicator: () => createElement("progress"),
    Alert: { alert: vi.fn() },
    RefreshControl: () => null,
    ScrollView: view,
    View: view,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
      createElement("button", { type: "button", onClick: onPress }, children),
    FlatList: ({
      ListHeaderComponent,
      ListEmptyComponent,
    }: {
      ListHeaderComponent?: ReactNode;
      ListEmptyComponent?: ReactNode;
    }) => createElement("div", null, ListHeaderComponent, ListEmptyComponent),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./native", () => ({
  native: color,
  useMobileTokens: () => color,
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => color }));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./routine", async (importOriginal) => ({
  ...(await importOriginal<typeof RoutineHelpers>()),
  deviceTimeZone: () => "Europe/Berlin",
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null }));

const routine = (id: string, name: string, partial: Partial<Routine> = {}) => ({
  id,
  name,
  prompt: "Check the inbox",
  active: true,
  crons: [],
  timezone: "Europe/Berlin",
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  nextRunAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...partial,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  params.current = { botId: "bot-fixture", name: "Fixture" };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render(element: ReactNode) {
  await act(async () => {
    root.render(element);
  });
}

function button(label: string) {
  const match = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(label),
  );
  if (!match) throw new Error(`No button "${label}" in: ${container.textContent}`);
  return match;
}

function profileRpc(routines: () => Promise<unknown>) {
  rpc.mockImplementation((procedure: string) => {
    if (procedure === "bots/get")
      return Promise.resolve({ id: "bot-fixture", name: "Fixture", title: "Helper", color: "c" });
    if (procedure === "routines/list") return routines();
    return Promise.reject(new Error(`unexpected ${procedure}`));
  });
}

describe("bot profile", () => {
  it("links the bot's settings, artifacts and computer", async () => {
    profileRpc(async () => []);
    await render(createElement(BotProfile));

    expect(container.textContent).toContain("Helper");
    button("Chat settings").click();
    button("Artifacts").click();
    button("Computer").click();
    expect(push.mock.calls).toEqual([
      [{ pathname: "/bot-settings", params: { botId: "bot-fixture" } }],
      [{ pathname: "/artifacts", params: { botId: "bot-fixture" } }],
      [{ pathname: "/computer", params: { botId: "bot-fixture", name: "Fixture" } }],
    ]);
  });

  it("hides routines while they load and when there are none", async () => {
    profileRpc(() => new Promise(() => undefined));
    await render(createElement(BotProfile));
    expect(rpc).toHaveBeenCalledWith("routines/list", { botId: "bot-fixture" });
    expect(container.textContent).not.toContain("Routines");

    act(() => root.unmount());
    root = createRoot(container);
    profileRpc(async () => []);
    await render(createElement(BotProfile));
    expect(container.textContent).not.toContain("Routines");
  });

  it("lists routines soonest first with readable details and opens them", async () => {
    profileRpc(async () => [
      routine("r3", "Inbox webhook", { webhookEnabled: true }),
      routine("r1", "Morning digest", {
        crons: ["0 7 * * 1-5"],
        nextRunAt: "2026-10-20T05:00:00.000Z",
      }),
      routine("r2", "Weekly report", {
        active: false,
        crons: ["0 9 * * 1"],
        timezone: "America/New_York",
        nextRunAt: "2026-10-19T13:00:00.000Z",
      }),
    ]);
    await render(createElement(BotProfile));

    expect(container.textContent).toContain("Routines");
    const rows = [...container.querySelectorAll("button")]
      .map((node) => node.textContent ?? "")
      .filter((text) => /digest|report|webhook/.test(text));
    expect(rows).toEqual([
      "Weekly reportEvery Monday at 9:00 AM · America/New_York · Paused",
      "Morning digestWeekdays at 7:00 AM",
      "Inbox webhookWebhook",
    ]);
    button("Weekly report").click();
    expect(push).toHaveBeenCalledWith({
      pathname: "/routine",
      params: { botId: "bot-fixture", botName: "Fixture", routineId: "r2", origin: "profile" },
    });
    expect(button("Morning digest")).toBeTruthy();
  });

  it("shows a failed routine load as a row that retries", async () => {
    let fail = true;
    profileRpc(async () => {
      if (fail) throw new Error("offline");
      return [routine("r1", "Morning digest")];
    });
    await render(createElement(BotProfile));
    expect(container.textContent).toContain("Routines");
    expect(container.textContent).toContain("offline");

    fail = false;
    await act(async () => button("Try again.").click());
    expect(container.textContent).not.toContain("Try again.");
    expect(button("Morning digest")).toBeTruthy();
  });

  it("lets only the latest routine load decide what shows", async () => {
    const loads: Array<{ resolve: (rows: unknown) => void; reject: (error: Error) => void }> = [];
    profileRpc(
      () =>
        new Promise((resolve, reject) => {
          loads.push({ resolve, reject });
        }),
    );
    await render(createElement(BotProfile));
    await act(async () => loads[0]!.reject(new Error("offline")));

    // Two quick retries; the newer one succeeds before the older one fails.
    await act(async () => button("Try again.").click());
    await act(async () => button("Try again.").click());
    await act(async () => loads[2]!.resolve([routine("r1", "Morning digest")]));
    await act(async () => loads[1]!.reject(new Error("offline")));

    expect(container.textContent).not.toContain("Try again.");
    expect(button("Morning digest")).toBeTruthy();
  });
});

describe("routine detail", () => {
  beforeEach(() => {
    params.current = { botId: "bot-fixture", botName: "Fixture", routineId: "r1" };
    profileRpc(async () => [routine("r1", "Morning digest")]);
  });

  it("hides Open conversation when opened from Profile", async () => {
    params.current.origin = "profile";
    await render(createElement(RoutineDetail));
    expect(container.textContent).toContain("Check the inbox");
    expect(container.textContent).not.toContain("Open conversation");
  });

  it("offers Open conversation without the Profile origin", async () => {
    await render(createElement(RoutineDetail));
    button("Open conversation").click();
    expect(push).toHaveBeenCalledWith({
      pathname: "/thread",
      params: { botId: "bot-fixture", name: "Fixture" },
    });
  });
});

describe("artifacts opened for one bot", () => {
  beforeEach(() => {
    rpc.mockResolvedValue([
      { id: "other-bot", name: "Other", color: "c" },
      { id: "bot-fixture", name: "Fixture", color: "c" },
    ]);
    listSpaceArtifacts.mockResolvedValue({ items: [], nextCursor: null });
    params.current = { botId: "bot-fixture" };
  });

  it("loads only the profile bot's artifacts initially", async () => {
    await render(createElement(ArtifactsScreen));
    expect(listSpaceArtifacts).toHaveBeenCalledTimes(1);
    expect(listSpaceArtifacts).toHaveBeenCalledWith({ botId: "bot-fixture", limit: 30 });
  });
});

describe("profile entry point", () => {
  it("adds one Profile action to the existing chat menu", () => {
    const thread = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../app/thread.tsx"),
      "utf8",
    );
    const actions = thread.slice(thread.indexOf("const botActions = ["));
    const list = actions.slice(0, actions.indexOf("\n  ];"));
    const labels = [...list.matchAll(/text: t\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(labels).toEqual([
      "Profile",
      "Chat settings",
      "Clear conversation",
      "Cancel",
      "Clear",
      "Archive",
      "Delete…",
    ]);
    expect(thread.match(/pathname: "\/bot-profile"/g)).toHaveLength(1);
    expect(list).toMatch(
      /pathname: "\/bot-profile",\s+params: \{ botId: botId \?\? "", name: displayName \?\? t\("Bot"\) \}/,
    );
  });
});
