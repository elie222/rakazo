// @vitest-environment jsdom

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

const { rpc, push, alert, afterChatNotifyChange, listSpaceArtifacts, params, color, focus } =
  vi.hoisted(() => ({
    rpc: vi.fn(),
    push: vi.fn(),
    alert: vi.fn(),
    afterChatNotifyChange: vi.fn(async () => undefined),
    listSpaceArtifacts: vi.fn(),
    params: { current: {} as Record<string, string> },
    color: new Proxy({}, { get: (_, key) => String(key) }),
    focus: new Set<() => (() => void) | undefined>(),
  }));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./api", () => ({
  rpc,
  currentApiBase: () => "https://api.example",
  loadSessionToken: async () => "token",
  selectedSpaceId: () => "space-a",
}));
vi.mock("./live-notifications", () => ({ afterChatNotifyChange }));
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
  useFocusEffect: (effect: () => (() => void) | undefined) => {
    useEffect(effect, [effect]);
    // Lets a test bring the screen back into view.
    useEffect(() => {
      focus.add(effect);
      return () => void focus.delete(effect);
    }, [effect]);
  },
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ fontScale: 1, width: 390 }),
    ActivityIndicator: () => createElement("progress"),
    Alert: { alert },
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
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    disabled,
    onValueChange,
    value,
  }: {
    accessibilityLabel: string;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
    value: boolean;
  }) =>
    createElement("input", {
      type: "checkbox",
      "aria-label": accessibilityLabel,
      checked: value,
      disabled,
      onChange: () => onValueChange(!value),
    }),
}));
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

const fixtureBot = {
  id: "bot-fixture",
  name: "Fixture",
  title: "Helper",
  color: "c",
  threadId: "thread-fixture",
  notifyOnFinish: true,
};

function profileRpc(
  routines: () => Promise<unknown>,
  {
    bot = async () => fixtureBot,
    update = async () => {
      throw new Error("unexpected bots/update");
    },
  }: { bot?: () => Promise<unknown>; update?: () => Promise<unknown> } = {},
) {
  rpc.mockImplementation((procedure: string) => {
    if (procedure === "bots/get") return bot();
    if (procedure === "routines/list") return routines();
    if (procedure === "bots/update") return update();
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

describe("bot profile notifications", () => {
  const footer = "Get notified when this Bot finishes or needs input";
  const notificationsSwitch = () =>
    container.querySelector<HTMLInputElement>('input[aria-label="Notifications"]');

  it("shows no switch until the bot has loaded", async () => {
    let load!: (bot: unknown) => void;
    profileRpc(async () => [], { bot: () => new Promise((resolve) => (load = resolve)) });
    await render(createElement(BotProfile));
    expect(notificationsSwitch()).toBeNull();
    expect(container.textContent).not.toContain(footer);

    await act(async () => load({ ...fixtureBot, notifyOnFinish: false }));
    expect(notificationsSwitch()?.checked).toBe(false);
  });

  it.each([true, false])(
    "shows the bot's setting (%s) after the routines, with what it covers",
    async (notifyOnFinish) => {
      profileRpc(async () => [routine("r1", "Morning digest")], {
        bot: async () => ({ ...fixtureBot, notifyOnFinish }),
      });
      await render(createElement(BotProfile));

      expect(notificationsSwitch()?.checked).toBe(notifyOnFinish);
      const text = container.textContent ?? "";
      expect(text.indexOf("Notifications")).toBeGreaterThan(text.indexOf("Morning digest"));
      expect(text.indexOf(footer)).toBeGreaterThan(text.indexOf("Notifications"));
    },
  );

  it("saves at once and keeps the switch enabled while saving", async () => {
    let save!: () => void;
    profileRpc(async () => [], {
      bot: async () => ({ ...fixtureBot, notifyOnFinish: false }),
      update: () => new Promise<void>((resolve) => (save = resolve)),
    });
    await render(createElement(BotProfile));

    await act(async () => notificationsSwitch()!.click());
    expect(notificationsSwitch()!.checked).toBe(true);
    expect(notificationsSwitch()!.disabled).toBe(false);
    expect(rpc).toHaveBeenCalledWith("bots/update", {
      botId: "bot-fixture",
      notifyOnFinish: true,
    });
    expect(afterChatNotifyChange).not.toHaveBeenCalled();

    await act(async () => save());
    expect(notificationsSwitch()!.checked).toBe(true);
    expect(notificationsSwitch()!.disabled).toBe(false);
    expect(rpc.mock.calls.filter(([procedure]) => procedure === "bots/update")).toHaveLength(1);
    expect(alert).not.toHaveBeenCalled();
  });

  it("keeps rapid on/off/on taps responsive and skips the redundant queued save", async () => {
    let save!: () => void;
    profileRpc(async () => [], {
      bot: async () => ({ ...fixtureBot, notifyOnFinish: false }),
      update: () => new Promise<void>((resolve) => (save = resolve)),
    });
    await render(createElement(BotProfile));
    for (const checked of [true, false, true]) {
      await act(async () => notificationsSwitch()!.click());
      expect(notificationsSwitch()!.checked).toBe(checked);
      expect(notificationsSwitch()!.disabled).toBe(false);
    }
    expect(rpc.mock.calls.filter(([procedure]) => procedure === "bots/update")).toEqual([
      ["bots/update", { botId: "bot-fixture", notifyOnFinish: true }],
    ]);
    await act(async () => save());
    expect(notificationsSwitch()!.checked).toBe(true);
    expect(rpc.mock.calls.filter(([procedure]) => procedure === "bots/update")).toHaveLength(1);
    expect(afterChatNotifyChange).toHaveBeenCalledExactlyOnceWith(
      "https://api.example",
      "token",
      "space-a",
      { threadId: "thread-fixture", notify: true },
    );
  });

  it("serializes taps and reverts a failed queued save to the last confirmed value", async () => {
    const requests: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    profileRpc(async () => [], {
      bot: async () => ({ ...fixtureBot, notifyOnFinish: false }),
      update: () => new Promise<void>((resolve, reject) => requests.push({ resolve, reject })),
    });
    await render(createElement(BotProfile));
    await act(async () => notificationsSwitch()!.click());
    await act(async () => notificationsSwitch()!.click());
    expect(notificationsSwitch()!.checked).toBe(false);
    expect(requests).toHaveLength(1);
    await act(async () => requests[0]!.resolve());
    expect(requests).toHaveLength(2);
    expect(rpc.mock.calls.filter(([procedure]) => procedure === "bots/update")).toEqual([
      ["bots/update", { botId: "bot-fixture", notifyOnFinish: true }],
      ["bots/update", { botId: "bot-fixture", notifyOnFinish: false }],
    ]);
    await act(async () => requests[1]!.reject(new Error("offline")));
    expect(notificationsSwitch()!.checked).toBe(true);
    expect(notificationsSwitch()!.disabled).toBe(false);
    expect(alert).toHaveBeenCalledWith("Could not update notifications", "offline");
    expect(afterChatNotifyChange).toHaveBeenCalledTimes(1);
  });

  it.each(["before", "during"])(
    "keeps the change when a reload that started %s the save returns the old value",
    async (when) => {
      const reads: Array<(bot: unknown) => void> = [];
      let save!: () => void;
      profileRpc(async () => [], {
        bot: () => new Promise((resolve) => reads.push(resolve)),
        update: () => new Promise<void>((resolve) => (save = resolve)),
      });
      await render(createElement(BotProfile));
      await act(async () => reads[0]!(fixtureBot));
      const refocus = () =>
        act(async () => {
          for (const effect of focus) effect();
        });

      if (when === "before") await refocus();
      await act(async () => notificationsSwitch()!.click());
      if (when === "during") await refocus();
      await act(async () => save());
      await act(async () => reads[1]!({ ...fixtureBot, title: "Reloaded" }));
      expect(container.textContent).toContain("Reloaded");
      expect(notificationsSwitch()!.checked).toBe(false);

      // A reload after the save shows the server's value again.
      await refocus();
      await act(async () => reads[2]!({ ...fixtureBot, notifyOnFinish: true }));
      expect(notificationsSwitch()!.checked).toBe(true);
    },
  );

  it("keeps the change when a reload starts and resolves while the save is pending", async () => {
    const reads: Array<(bot: unknown) => void> = [];
    let save!: () => void;
    profileRpc(async () => [], {
      bot: () => new Promise((resolve) => reads.push(resolve)),
      update: () => new Promise<void>((resolve) => (save = resolve)),
    });
    await render(createElement(BotProfile));
    await act(async () => reads[0]!(fixtureBot));
    const refocus = () =>
      act(async () => {
        for (const effect of focus) effect();
      });

    await act(async () => notificationsSwitch()!.click());
    await refocus();
    await act(async () => reads[1]!({ ...fixtureBot, title: "Reloaded" }));
    expect(container.textContent).toContain("Reloaded");
    expect(notificationsSwitch()!.checked).toBe(false);
    expect(notificationsSwitch()!.disabled).toBe(false);

    await act(async () => save());
    expect(notificationsSwitch()!.checked).toBe(false);
    expect(notificationsSwitch()!.disabled).toBe(false);

    await refocus();
    await act(async () => reads[2]!(fixtureBot));
    expect(notificationsSwitch()!.checked).toBe(true);
  });

  it("moves the switch back and says so when the save fails", async () => {
    profileRpc(async () => [], {
      update: async () => {
        throw new Error("offline");
      },
    });
    await render(createElement(BotProfile));

    await act(async () => notificationsSwitch()!.click());
    expect(notificationsSwitch()!.checked).toBe(true);
    expect(notificationsSwitch()!.disabled).toBe(false);
    expect(alert).toHaveBeenCalledWith("Could not update notifications", "offline");
    expect(afterChatNotifyChange).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "brings the device in line after a save (turned on: %s)",
    async (notify) => {
      profileRpc(async () => [], {
        bot: async () => ({ ...fixtureBot, notifyOnFinish: !notify }),
        update: async () => undefined,
      });
      await render(createElement(BotProfile));

      await act(async () => notificationsSwitch()!.click());
      expect(afterChatNotifyChange).toHaveBeenCalledExactlyOnceWith(
        "https://api.example",
        "token",
        "space-a",
        { threadId: "thread-fixture", notify },
      );
    },
  );
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
