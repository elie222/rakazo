// @vitest-environment jsdom

import type { Routine } from "@rakazo/contracts";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ArtifactsScreen from "../app/artifacts";
import BotProfile from "../app/bot-profile";
import RoutineDetail from "../app/routine";
import RoutinesScreen from "../app/routines";
import { queryClient } from "./query";
import type * as RoutineHelpers from "./routine";
import { ROUTINES_POLL_MS, ROUTINES_RETRY_MS } from "./routine-store";

const {
  rpc,
  push,
  alert,
  afterChatNotifyChange,
  listSpaceArtifacts,
  params,
  color,
  focus,
  session,
  requestContext,
} = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  alert: vi.fn(),
  afterChatNotifyChange: vi.fn(async () => undefined),
  listSpaceArtifacts: vi.fn(),
  params: { current: {} as Record<string, string> },
  color: new Proxy({}, { get: (_, key) => String(key) }),
  focus: new Set<() => (() => void) | undefined>(),
  session: { generation: 0 },
  requestContext: vi.fn(),
}));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./api", () => ({
  rpc,
  currentApiBase: () => "https://api.example",
  loadSessionToken: async () => "token",
  selectedSpaceId: () => "space-a",
  captureApiRequestContext: requestContext,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => session.generation }));
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
    Pressable: ({
      children,
      onPress,
      onLongPress,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      onLongPress?: () => void;
      accessibilityLabel?: string;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          onContextMenu: onLongPress,
          "aria-label": accessibilityLabel,
        },
        children,
      ),
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
  const t = (text: string, values: Record<string, string | number> = {}) =>
    text.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
  return {
    t,
    useI18n: () => ({ t, locale: "en" }),
    getActiveUiLocale: () => "en",
    dateLocaleForUi: () => "en-US",
  };
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
      // A native switch takes its own touches; the row around it doesn't see them.
      onClick: (event: Event) => event.stopPropagation(),
    }),
}));
vi.mock("../components/run-error-sheet", () => ({
  useRunError: (details: string | null) => (details ? { summary: `summary: ${details}` } : null),
  RunErrorSheet: ({ details }: { details: string | null }) =>
    details ? createElement("dialog", { open: true }, details) : null,
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

// Cached reads reach the screens in the same act() as the answer, as in the other query tests.
notifyManager.setScheduler((callback) => callback());

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  params.current = { botId: "bot-fixture", name: "Fixture" };
  // Each test starts a new session, so routines read in one never show in the next.
  session.generation += 1;
  requestContext.mockImplementation(async () => ({
    apiBase: "https://api.example",
    headers: { "x-rakazo-space-id": "space-a" },
    sessionGeneration: session.generation,
  }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
  queryClient.clear();
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
    updateRoutine = async () => {
      throw new Error("unexpected routines/update");
    },
    removeRoutine = async () => {
      throw new Error("unexpected routines/remove");
    },
    history = async () => ({ runs: [], nextCursor: null }),
  }: {
    bot?: () => Promise<unknown>;
    update?: () => Promise<unknown>;
    updateRoutine?: (input: { routineId: string; active: boolean }) => Promise<unknown>;
    removeRoutine?: (input: { routineId: string }) => Promise<unknown>;
    history?: (input: { routineId: string; before?: unknown }) => Promise<unknown>;
  } = {},
) {
  rpc.mockImplementation((procedure: string, input: never) => {
    if (procedure === "bots/get") return bot();
    if (procedure === "routines/list") return routines();
    if (procedure === "bots/update") return update();
    if (procedure === "routines/update") return updateRoutine(input);
    if (procedure === "routines/remove") return removeRoutine(input);
    if (procedure === "routines/history") return history(input);
    return Promise.reject(new Error(`unexpected ${procedure}`));
  });
}

const listCalls = () => rpc.mock.calls.filter(([procedure]) => procedure === "routines/list");
const routinesRow = () => button("Routines");

describe("bot profile", () => {
  it("links the bot's settings, routines, artifacts and computer", async () => {
    profileRpc(async () => []);
    await render(createElement(BotProfile));

    expect(container.textContent).toContain("Fixture");
    button("Chat settings").click();
    routinesRow().click();
    button("Artifacts").click();
    button("Computer").click();
    expect(push.mock.calls).toEqual([
      [{ pathname: "/bot-settings", params: { botId: "bot-fixture" } }],
      [{ pathname: "/routines", params: { botId: "bot-fixture", name: "Fixture" } }],
      [{ pathname: "/artifacts", params: { botId: "bot-fixture" } }],
      [{ pathname: "/computer", params: { botId: "bot-fixture", name: "Fixture" } }],
    ]);
    const rows = [...container.querySelectorAll("button")].map((node) => node.textContent);
    expect(rows.slice(0, 4)).toEqual(["Chat settings", "Routines0 on", "Artifacts", "Computer"]);
  });

  it.each([
    ["no routines", [], "0 on"],
    [
      "two of three on",
      [
        routine("r1", "Morning digest"),
        routine("r2", "Weekly report", { active: false }),
        routine("r3", "Inbox webhook", { webhookEnabled: true }),
      ],
      "2 on",
    ],
    ["all paused", [routine("r1", "Morning digest", { active: false })], "0 on"],
  ])("counts the routines that are on (%s)", async (_, rows, count) => {
    profileRpc(async () => rows);
    await render(createElement(BotProfile));
    expect(routinesRow().textContent).toBe(`Routines${count}`);
    // The routines themselves are on the Routines screen, not the profile.
    expect(container.textContent).not.toContain("Morning digest");
  });

  it("shows the row without a count until the first read lands", async () => {
    let load!: (rows: unknown) => void;
    profileRpc(() => new Promise((resolve) => (load = resolve)));
    await render(createElement(BotProfile));
    expect(rpc).toHaveBeenCalledWith("routines/list", { botId: "bot-fixture" }, expect.anything());
    expect(routinesRow().textContent).toBe("Routines");

    await act(async () => load([routine("r1", "Morning digest")]));
    expect(routinesRow().textContent).toBe("Routines1 on");
  });

  it("tries a failed read once more, then keeps the row without a count", async () => {
    vi.useFakeTimers();
    profileRpc(async () => {
      throw new Error("offline");
    });
    await render(createElement(BotProfile));
    await act(async () => vi.advanceTimersByTimeAsync(ROUTINES_RETRY_MS));

    expect(listCalls()).toHaveLength(2);
    expect(routinesRow().textContent).toBe("Routines");
    expect(container.textContent).not.toContain("offline");
    routinesRow().click();
    expect(push).toHaveBeenCalledWith({
      pathname: "/routines",
      params: { botId: "bot-fixture", name: "Fixture" },
    });
  });

  it("shows the count from a failed first try once the retry succeeds", async () => {
    vi.useFakeTimers();
    let fail = true;
    profileRpc(async () => {
      if (fail) {
        fail = false;
        throw new Error("offline");
      }
      return [routine("r1", "Morning digest")];
    });
    await render(createElement(BotProfile));
    expect(routinesRow().textContent).toBe("Routines");
    await act(async () => vi.advanceTimersByTimeAsync(ROUTINES_RETRY_MS));
    expect(routinesRow().textContent).toBe("Routines1 on");
  });

  it("reads again every 15 seconds while shown, and stops when it closes", async () => {
    vi.useFakeTimers();
    let rows = [routine("r1", "Morning digest")];
    profileRpc(async () => rows);
    await render(createElement(BotProfile));
    expect(listCalls()).toHaveLength(1);

    rows = [...rows, routine("r2", "Weekly report", { createdAt: "2026-02-01T00:00:00.000Z" })];
    await act(async () => vi.advanceTimersByTimeAsync(ROUTINES_POLL_MS));
    expect(listCalls()).toHaveLength(2);
    expect(routinesRow().textContent).toBe("Routines2 on");

    act(() => root.unmount());
    await act(async () => vi.advanceTimersByTimeAsync(ROUTINES_POLL_MS * 2));
    expect(listCalls()).toHaveLength(2);
    root = createRoot(container);
  });

  it("keeps routines in memory only for the session", async () => {
    profileRpc(async () => [routine("r1", "Morning digest")]);
    await render(createElement(BotProfile));
    expect(routinesRow().textContent).toBe("Routines1 on");
    act(() => root.unmount());

    session.generation += 1;
    root = createRoot(container);
    profileRpc(() => new Promise(() => undefined));
    await render(createElement(BotProfile));
    expect(routinesRow().textContent).toBe("Routines");
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
      expect(text.indexOf("Notifications")).toBeGreaterThan(text.indexOf("Routines"));
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
      await act(async () => reads[1]!({ ...fixtureBot, name: "Reloaded" }));
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
    await act(async () => reads[1]!({ ...fixtureBot, name: "Reloaded" }));
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

describe("routines screen", () => {
  const digest = () =>
    routine("r1", "Morning digest", {
      crons: ["30 7 * * *"],
      nextRunAt: "2026-10-26T06:30:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  const report = () =>
    routine("r2", "Weekly report", {
      active: false,
      crons: ["43 */2 * * *"],
      createdAt: "2026-02-01T00:00:00.000Z",
    });
  const switchFor = (name: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="Active: ${name}"]`);
  const rowFor = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const rowTexts = () =>
    [...container.querySelectorAll("button[aria-label]")].map((node) => node.textContent);

  it("lists routines oldest first with their schedule, state and switch", async () => {
    // The server's order and the next run don't decide the order.
    profileRpc(async () => [report(), digest()]);
    await render(createElement(RoutinesScreen));

    expect(rowTexts()).toEqual([
      "Morning digestEvery day at 7:30 AM",
      "Weekly reportEvery 2 hours at :43, Paused",
    ]);
    expect(rowFor("Morning digest, On")).toBeTruthy();
    expect(rowFor("Weekly report, Off")).toBeTruthy();
    expect(switchFor("Morning digest")?.checked).toBe(true);
    expect(switchFor("Weekly report")?.checked).toBe(false);
  });

  it("opens a routine from its text, not from its switch", async () => {
    profileRpc(async () => [digest()], {
      updateRoutine: () => new Promise(() => undefined),
    });
    await render(createElement(RoutinesScreen));
    await act(async () => switchFor("Morning digest")!.click());
    expect(push).not.toHaveBeenCalled();

    rowFor("Morning digest, Off")!.click();
    expect(push).toHaveBeenCalledWith({
      pathname: "/routine",
      params: { botId: "bot-fixture", botName: "Fixture", routineId: "r1", origin: "profile" },
    });
  });

  it("shows a spinner, then the empty text, with no list or button", async () => {
    let load!: (rows: unknown) => void;
    profileRpc(() => new Promise((resolve) => (load = resolve)));
    await render(createElement(RoutinesScreen));
    expect(container.querySelector("progress")).toBeTruthy();
    expect(container.textContent).toBe("");

    await act(async () => load([]));
    expect(container.querySelector("progress")).toBeNull();
    expect(container.textContent).toBe("Ask this Bot in chat to set up a routine.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("offers Try Again after a failed read and its retry, and reloads", async () => {
    vi.useFakeTimers();
    let fail = true;
    profileRpc(async () => {
      if (fail) throw new Error("offline");
      return [digest()];
    });
    await render(createElement(RoutinesScreen));
    expect(container.querySelector("progress")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(ROUTINES_RETRY_MS));
    expect(container.textContent).toBe("Could not load routinesTry Again");

    fail = false;
    await act(async () => button("Try Again").click());
    expect(rowFor("Morning digest, On")).toBeTruthy();
  });

  it("keeps the list when a later read fails", async () => {
    vi.useFakeTimers();
    let fail = false;
    profileRpc(async () => {
      if (fail) throw new Error("offline");
      return [digest()];
    });
    await render(createElement(RoutinesScreen));
    fail = true;
    await act(async () => vi.advanceTimersByTimeAsync(ROUTINES_POLL_MS + ROUTINES_RETRY_MS));
    expect(listCalls()).toHaveLength(3);
    expect(rowFor("Morning digest, On")).toBeTruthy();
    expect(container.textContent).not.toContain("Could not load routines");
  });

  it("shows what the profile read at once and still reads again", async () => {
    profileRpc(async () => [digest()]);
    await render(createElement(BotProfile));
    act(() => root.unmount());
    root = createRoot(container);

    profileRpc(() => new Promise(() => undefined));
    await render(createElement(RoutinesScreen));
    expect(container.querySelector("progress")).toBeNull();
    expect(rowFor("Morning digest, On")).toBeTruthy();
    expect(listCalls()).toHaveLength(2);
  });

  it("pauses at once, saves once, keeps the row in place and updates the profile count", async () => {
    let save!: (row: unknown) => void;
    const updateRoutine = vi.fn(() => new Promise((resolve) => (save = resolve)));
    profileRpc(async () => [digest(), report()], { updateRoutine });
    await render(createElement(RoutinesScreen));

    await act(async () => switchFor("Morning digest")!.click());
    expect(switchFor("Morning digest")!.checked).toBe(false);
    expect(rowTexts()).toEqual([
      "Morning digestEvery day at 7:30 AM, Paused",
      "Weekly reportEvery 2 hours at :43, Paused",
    ]);
    expect(updateRoutine).toHaveBeenCalledExactlyOnceWith({ routineId: "r1", active: false });

    // Pausing clears the next run; the row still stays first.
    await act(async () => save({ ...digest(), active: false, nextRunAt: null }));
    expect(rowTexts()[0]).toBe("Morning digestEvery day at 7:30 AM, Paused");
    expect(alert).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(container);
    profileRpc(() => new Promise(() => undefined));
    await render(createElement(BotProfile));
    expect(routinesRow().textContent).toBe("Routines0 on");
  });

  it("sends a save with the account and space of the tap", async () => {
    profileRpc(async () => [digest()], {
      updateRoutine: async () => ({ ...digest(), active: false }),
    });
    await render(createElement(RoutinesScreen));
    await act(async () => switchFor("Morning digest")!.click());
    expect(rpc).toHaveBeenCalledWith(
      "routines/update",
      { routineId: "r1", active: false },
      {
        requestContext: {
          apiBase: "https://api.example",
          headers: { "x-rakazo-space-id": "space-a" },
          sessionGeneration: session.generation,
        },
      },
    );
  });

  it("drops a save when the session changes between the tap and the send", async () => {
    let captured!: (context: unknown) => void;
    const updateRoutine = vi.fn(async () => ({ ...digest(), active: false }));
    profileRpc(async () => [digest()], { updateRoutine });
    await render(createElement(RoutinesScreen));
    requestContext.mockImplementationOnce(() => new Promise((resolve) => (captured = resolve)));

    await act(async () => switchFor("Morning digest")!.click());
    expect(switchFor("Morning digest")!.checked).toBe(false);
    session.generation += 1;
    await act(async () =>
      captured({ apiBase: "https://api.example", headers: {}, sessionGeneration: 0 }),
    );
    expect(updateRoutine).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("writes only the latest of quick taps, one save at a time", async () => {
    const saves: Array<(row: unknown) => void> = [];
    const updateRoutine = vi.fn(
      ({ active }: { active: boolean }) =>
        new Promise((resolve) => saves.push(() => resolve({ ...digest(), active }))),
    );
    profileRpc(async () => [digest()], { updateRoutine });
    await render(createElement(RoutinesScreen));

    for (const checked of [false, true, false, true]) {
      await act(async () => switchFor("Morning digest")!.click());
      expect(switchFor("Morning digest")!.checked).toBe(checked);
    }
    expect(updateRoutine.mock.calls).toEqual([[{ routineId: "r1", active: false }]]);
    await act(async () => saves[0]!(undefined));
    expect(updateRoutine.mock.calls).toEqual([
      [{ routineId: "r1", active: false }],
      [{ routineId: "r1", active: true }],
    ]);
    expect(switchFor("Morning digest")!.checked).toBe(true);
    await act(async () => saves[1]!(undefined));
    expect(updateRoutine).toHaveBeenCalledTimes(2);
    expect(switchFor("Morning digest")!.checked).toBe(true);
  });

  it("moves a switch back and says so when its save fails", async () => {
    profileRpc(async () => [digest(), report()], {
      updateRoutine: async () => {
        throw new Error("This one-shot already ran.");
      },
    });
    await render(createElement(RoutinesScreen));

    await act(async () => switchFor("Weekly report")!.click());
    expect(switchFor("Weekly report")!.checked).toBe(false);
    expect(rowTexts()).toEqual([
      "Morning digestEvery day at 7:30 AM",
      "Weekly reportEvery 2 hours at :43, Paused",
    ]);
    expect(alert).toHaveBeenCalledExactlyOnceWith(
      "Could not update routine",
      "This one-shot already ran.",
    );
  });

  it("stays quiet about a failed save a newer tap replaced", async () => {
    const saves: Array<{ resolve: (row: unknown) => void; reject: (error: Error) => void }> = [];
    profileRpc(async () => [digest()], {
      updateRoutine: () => new Promise((resolve, reject) => saves.push({ resolve, reject })),
    });
    await render(createElement(RoutinesScreen));
    for (let tap = 0; tap < 3; tap += 1) {
      await act(async () => switchFor("Morning digest")!.click());
    }
    await act(async () => saves[0]!.reject(new Error("offline")));
    expect(alert).not.toHaveBeenCalled();
    expect(switchFor("Morning digest")!.checked).toBe(false);
    // The newer value is still written.
    expect(saves).toHaveLength(2);
    await act(async () => saves[1]!.resolve({ ...digest(), active: false }));
    expect(switchFor("Morning digest")!.checked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("keeps a switch as tapped when a read that overlapped its save returns the old value", async () => {
    vi.useFakeTimers();
    const reads: Array<(rows: unknown) => void> = [];
    let save!: (row: unknown) => void;
    profileRpc(() => new Promise((resolve) => reads.push(resolve)), {
      updateRoutine: () => new Promise((resolve) => (save = resolve)),
    });
    await render(createElement(RoutinesScreen));
    await act(async () => reads[0]!([digest()]));

    await act(async () => vi.advanceTimersByTimeAsync(ROUTINES_POLL_MS));
    await act(async () => switchFor("Morning digest")!.click());
    await act(async () => save({ ...digest(), active: false }));
    await act(async () => reads[1]!([digest()]));
    expect(switchFor("Morning digest")!.checked).toBe(false);

    // The next read that started after the save shows the server again.
    await act(async () => vi.advanceTimersByTimeAsync(ROUTINES_POLL_MS));
    await act(async () => reads[2]!([{ ...digest(), active: true }]));
    expect(switchFor("Morning digest")!.checked).toBe(true);
  });

  it("disables the switch and delete for a routine another member created", async () => {
    profileRpc(async () => [{ ...digest(), editable: false }]);
    await render(createElement(RoutinesScreen));
    expect(switchFor("Morning digest")!.disabled).toBe(true);
    rowFor("Morning digest, On")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(alert).not.toHaveBeenCalled();
  });

  it("asks before deleting and removes the row only once the server confirms", async () => {
    let remove!: (value: unknown) => void;
    const removeRoutine = vi.fn(() => new Promise((resolve) => (remove = resolve)));
    profileRpc(async () => [digest(), report()], { removeRoutine });
    await render(createElement(RoutinesScreen));

    rowFor("Morning digest, On")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(alert).toHaveBeenCalledWith(
      'Delete "Morning digest"?',
      "This permanently deletes the routine and its run history.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: expect.any(Function) },
      ],
    );
    expect(removeRoutine).not.toHaveBeenCalled();
    const [, , buttons] = alert.mock.calls[0] as [string, string, Array<{ onPress?: () => void }>];
    await act(async () => buttons[1]!.onPress!());
    expect(removeRoutine).toHaveBeenCalledExactlyOnceWith({ routineId: "r1" });
    expect(rowFor("Morning digest, On")).toBeTruthy();

    // No second delete while one is in flight.
    rowFor("Weekly report, Off")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(alert).toHaveBeenCalledTimes(1);

    await act(async () => remove({ ok: true }));
    expect(rowFor("Morning digest, On")).toBeNull();
    expect(rowFor("Weekly report, Off")).toBeTruthy();
  });

  const confirmDelete = async (label: string) => {
    alert.mockClear();
    rowFor(label)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const [, , buttons] = alert.mock.calls[0] as [string, string, Array<{ onPress?: () => void }>];
    await act(async () => buttons[1]!.onPress!());
  };

  it("sends a delete with the account and space of the confirmation", async () => {
    profileRpc(async () => [digest(), report()], { removeRoutine: async () => ({ ok: true }) });
    await render(createElement(RoutinesScreen));
    await confirmDelete("Morning digest, On");
    expect(rpc).toHaveBeenCalledWith(
      "routines/remove",
      { routineId: "r1" },
      {
        requestContext: {
          apiBase: "https://api.example",
          headers: { "x-rakazo-space-id": "space-a" },
          sessionGeneration: session.generation,
        },
      },
    );
    expect(rowFor("Morning digest, On")).toBeNull();
  });

  it("drops a delete when the session changes between the confirmation and the send", async () => {
    const removeRoutine = vi.fn(async () => ({ ok: true }));
    profileRpc(async () => [digest(), report()], { removeRoutine });
    await render(createElement(RoutinesScreen));
    let captured!: (context: unknown) => void;
    requestContext.mockImplementationOnce(() => new Promise((resolve) => (captured = resolve)));
    await confirmDelete("Morning digest, On");
    session.generation += 1;
    await act(async () =>
      captured({ apiBase: "https://api.example", headers: {}, sessionGeneration: 0 }),
    );
    expect(removeRoutine).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("names a routine without a name generically and keeps it when the delete fails", async () => {
    profileRpc(async () => [routine("r1", " ")], {
      removeRoutine: async () => {
        throw new Error("offline");
      },
    });
    await render(createElement(RoutinesScreen));
    rowFor(" , On")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(alert.mock.calls[0]?.[0]).toBe("Delete this routine?");
    const [, , buttons] = alert.mock.calls[0] as [string, string, Array<{ onPress?: () => void }>];
    await act(async () => buttons[1]!.onPress!());
    expect(alert).toHaveBeenLastCalledWith("Could not delete routine", "offline");
    expect(rowFor(" , On")).toBeTruthy();
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

  it("shows a routine the list already read without waiting, and still reads again", async () => {
    params.current = { botId: "bot-fixture", name: "Fixture" };
    await render(createElement(RoutinesScreen));
    act(() => root.unmount());
    root = createRoot(container);

    params.current = { botId: "bot-fixture", botName: "Fixture", routineId: "r1" };
    profileRpc(() => new Promise(() => undefined));
    await render(createElement(RoutineDetail));
    expect(container.querySelector("progress")).toBeNull();
    expect(container.textContent).toContain("Check the inbox");
    expect(listCalls()).toHaveLength(2);
  });

  it("reads again once a save running when it opened finishes", async () => {
    let save!: (row: unknown) => void;
    params.current = { botId: "bot-fixture", name: "Fixture" };
    profileRpc(async () => [routine("r1", "Morning digest"), routine("r2", "Weekly report")], {
      updateRoutine: () => new Promise((resolve) => (save = resolve)),
    });
    await render(createElement(RoutinesScreen));
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('input[aria-label="Active: Weekly report"]')!
        .click(),
    );
    act(() => root.unmount());
    root = createRoot(container);

    // The routine's prompt changed elsewhere; the read waits for the other routine's save.
    rpc.mockClear();
    profileRpc(
      async () => [
        routine("r1", "Morning digest", { prompt: "Check the inbox and the calendar" }),
        routine("r2", "Weekly report", { active: false }),
      ],
      { updateRoutine: () => new Promise((resolve) => (save = resolve)) },
    );
    params.current = { botId: "bot-fixture", botName: "Fixture", routineId: "r1" };
    await render(createElement(RoutineDetail));
    expect(listCalls()).toHaveLength(0);

    await act(async () => save(routine("r2", "Weekly report", { active: false })));
    expect(listCalls()).toHaveLength(1);
    expect(container.textContent).toContain("Check the inbox and the calendar");
  });

  it("waits for a fresh read before calling a routine that isn't cached yet gone", async () => {
    // The bot's list was read earlier, before the routine was created elsewhere.
    params.current = { botId: "bot-fixture", name: "Fixture" };
    profileRpc(async () => []);
    await render(createElement(BotProfile));
    act(() => root.unmount());
    root = createRoot(container);

    let load!: (rows: unknown) => void;
    profileRpc(() => new Promise((resolve) => (load = resolve)));
    params.current = { botId: "bot-fixture", botName: "Fixture", routineId: "r1" };
    await render(createElement(RoutineDetail));
    expect(container.textContent).not.toContain("This routine no longer exists");
    expect(container.querySelector("progress")).toBeTruthy();

    await act(async () => load([routine("r1", "Morning digest")]));
    expect(container.textContent).toContain("Check the inbox");
  });

  it("shows the load error, not a missing routine, when the fresh read fails", async () => {
    vi.useFakeTimers();
    params.current = { botId: "bot-fixture", name: "Fixture" };
    profileRpc(async () => []);
    await render(createElement(BotProfile));
    act(() => root.unmount());
    root = createRoot(container);

    profileRpc(async () => {
      throw new Error("offline");
    });
    params.current = { botId: "bot-fixture", botName: "Fixture", routineId: "r1" };
    await render(createElement(RoutineDetail));
    await act(async () => vi.advanceTimersByTimeAsync(ROUTINES_RETRY_MS));
    expect(container.textContent).toContain("offline");
    expect(container.textContent).not.toContain("This routine no longer exists");
  });

  it("says when the routine is gone", async () => {
    profileRpc(async () => [routine("r2", "Weekly report")]);
    await render(createElement(RoutineDetail));
    expect(container.textContent).toContain("This routine no longer exists");
  });

  it("lists the routine's runs and opens a reply at its message", async () => {
    const run = {
      id: "run-1",
      botId: "bot-fixture",
      groupId: null,
      status: "completed",
      error: null,
      createdAt: "2026-01-02T12:00:00Z",
      startedAt: "2026-01-02T12:00:00Z",
      completedAt: "2026-01-02T12:01:22Z",
      messageId: "reply-1",
    };
    profileRpc(async () => [routine("r1", "Morning digest")], {
      history: async () => ({
        runs: [
          run,
          { ...run, id: "run-2", groupId: "group-1", messageId: "reply-2" },
          { ...run, id: "run-3", status: "failed", error: "504: timed out", messageId: null },
        ],
        nextCursor: null,
      }),
    });
    await render(createElement(RoutineDetail));
    expect(container.textContent).toContain("Run history");
    expect(container.textContent).not.toContain("1m 22s");
    expect(container.textContent).not.toContain("Done");
    expect(container.textContent).toContain("summary: 504: timed out");
    expect(container.textContent).not.toContain("Load older runs");
    const rows = [...container.querySelectorAll("button")].filter((node) =>
      node.textContent?.includes("Jan 2,"),
    );
    expect(rows).toHaveLength(3);
    rows[0]!.click();
    expect(push).toHaveBeenLastCalledWith({
      pathname: "/thread",
      params: { botId: "bot-fixture", messageId: "reply-1", name: "Fixture" },
    });
    rows[1]!.click();
    expect(push).toHaveBeenLastCalledWith({
      pathname: "/group-thread",
      params: { groupId: "group-1", messageId: "reply-2" },
    });
    await act(async () => rows[2]!.click());
    expect(container.querySelector("dialog")?.textContent).toBe("504: timed out");
  });

  it("loads older runs a page at a time", async () => {
    const run = {
      id: "run-1",
      botId: "bot-fixture",
      groupId: null,
      status: "completed",
      error: null,
      createdAt: "2026-01-02T12:00:00Z",
      startedAt: null,
      completedAt: null,
      messageId: null,
    };
    const cursor = { id: "run-1", createdAt: run.createdAt };
    const history = vi.fn(async (input: { before?: unknown }) =>
      input.before
        ? { runs: [run, { ...run, id: "run-2" }], nextCursor: null }
        : { runs: [run], nextCursor: cursor },
    );
    profileRpc(async () => [routine("r1", "Morning digest")], { history });
    await render(createElement(RoutineDetail));
    await act(async () => button("Load older runs").click());
    expect(history).toHaveBeenLastCalledWith({ routineId: "r1", before: cursor, limit: 20 });
    expect(container.textContent?.match(/Jan 2,/g)).toHaveLength(2);
    expect(container.textContent).not.toContain("Load older runs");
  });

  it("says when older runs could not load and keeps what is shown", async () => {
    const run = {
      id: "run-1",
      botId: "bot-fixture",
      groupId: null,
      status: "completed",
      error: null,
      createdAt: "2026-01-02T12:00:00Z",
      startedAt: null,
      completedAt: null,
      messageId: null,
    };
    const history = vi.fn(async (input: { before?: unknown }) => {
      if (input.before) throw new Error("offline");
      return { runs: [run], nextCursor: { id: "run-1", createdAt: run.createdAt } };
    });
    profileRpc(async () => [routine("r1", "Morning digest")], { history });
    await render(createElement(RoutineDetail));
    await act(async () => button("Load older runs").click());
    expect(container.textContent).toContain("Could not load run history");
    expect(container.textContent?.match(/Jan 2,/g)).toHaveLength(1);
    expect(container.textContent).toContain("Load older runs");
  });

  it("says when a routine has not run, and when its history could not load", async () => {
    await render(createElement(RoutineDetail));
    expect(container.textContent).toContain("No runs yet");
    act(() => root.unmount());
    root = createRoot(container);
    queryClient.clear();

    const history = vi.fn(async () => {
      throw new Error("offline");
    });
    profileRpc(async () => [routine("r1", "Morning digest")], { history });
    await render(createElement(RoutineDetail));
    expect(container.textContent).toContain("Could not load run history");
    history.mockImplementation(async () => ({ runs: [], nextCursor: null }) as never);
    await act(async () => button("Try Again").click());
    expect(container.textContent).toContain("No runs yet");
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
