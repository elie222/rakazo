// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SearchSheet from "../app/search";
import { selectSpace } from "./api";
import type { InboxSpace } from "./inbox-spaces";
import { searchKindLabel } from "./search-sheet";

const state = vi.hoisted(() => ({
  search: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  addListener: vi.fn(),
  lifecycle: new Map<string, () => void>(),
  selectSpace: vi.fn(),
  selectionSeq: 0,
  spaceId: "space-a" as string | null,
  persistedSpaceId: "space-a",
  generation: 1,
  apiBase: "https://example.test",
  dismiss: vi.fn(),
  alert: vi.fn(),
  platform: { OS: "ios" },
}));
const bot = {
  id: "bot-a",
  name: "Scout",
  title: "Research",
  preview: "Latest reply",
  spaceId: "space-a",
  color: "gray",
  status: "idle",
};
const group = {
  id: "group-a",
  name: "Team",
  preview: "Team reply",
  spaceId: "space-b",
  members: [],
};
// An archived bot sits in the roster while its read-only chat opens; search must skip it.
const archived = { ...bot, id: "bot-archived", name: "Old helper", archivedAt: "2026-01-02" };
const spaces = [
  { id: "space-a", bots: [bot, archived], groups: [group] },
] as unknown as InboxSpace[];
const message = {
  kind: "message" as const,
  botId: "bot-a",
  botName: "Scout",
  title: "Found note",
  snippet: "A **matching** line",
  messageId: "message-a",
};
vi.mock("expo-router", () => ({
  useRouter: () => state,
  useNavigation: () => state,
  useFocusEffect: (effect: () => () => void) =>
    useEffect(() => {
      const cleanup = effect();
      state.lifecycle.set("blur", cleanup);
      return cleanup;
    }, [effect]),
}));
vi.mock("./api", () => ({
  selectSpace: (id: string) => {
    state.selectionSeq++;
    return state.selectSpace(id);
  },
  spaceSelectionSeq: () => state.selectionSeq,
  selectedSpaceId: () => state.spaceId,
  currentApiBase: () => state.apiBase,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => state.generation }));
vi.mock("./search", () => ({ querySpaceSearch: state.search }));
vi.mock("./search-inbox", () => ({
  getSearchInbox: () => spaces,
  subscribeSearchInbox: () => () => {},
}));
vi.mock("./appearance", () => ({
  mobileTokens: () => ({}),
  resolveMobileAppearance: () => "dark",
}));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text, locale: "en" }),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: state.dismiss },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => <span>bot avatar</span> }));
vi.mock("../components/group-avatar", () => ({ GroupAvatar: () => <span>group avatar</span> }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/glass-icon-button", () => ({
  GlassIconButton: ({ testID, onPress }: { testID: string; onPress: () => void }) => (
    <button type="button" data-testid={testID} onClick={onPress}>
      Close
    </button>
  ),
}));
vi.mock("react-native", () => ({
  Platform: state.platform,
  Alert: { alert: state.alert },
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ width: 390 }),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    ref,
    value,
    onChangeText,
    testID,
    ...props
  }: {
    ref: React.Ref<HTMLInputElement>;
    value: string;
    onChangeText: (text: string) => void;
    testID: string;
  }) => (
    <input
      ref={ref}
      data-testid={testID}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      data-keyboard={JSON.stringify(props)}
    />
  ),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  FlatList: ({
    data,
    renderItem,
    ListEmptyComponent,
  }: {
    data: { key: string }[];
    renderItem: (info: { item: unknown }) => ReactNode;
    ListEmptyComponent: ReactNode;
  }) => (
    <div>
      {data.length
        ? data.map((item) => <div key={item.key}>{renderItem({ item })}</div>)
        : ListEmptyComponent}
    </div>
  ),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.lifecycle.clear();
  state.addListener.mockImplementation((event: string, listener: () => void) => {
    state.lifecycle.set(event, listener);
    return () => state.lifecycle.delete(event);
  });
  state.platform.OS = "ios";
  state.search.mockResolvedValue([]);
  state.spaceId = "space-a";
  state.selectionSeq = 0;
  state.persistedSpaceId = "space-a";
  state.generation = 1;
  state.apiBase = "https://example.test";
  state.selectSpace.mockImplementation(async (id: string) => {
    state.spaceId = id || null;
    state.persistedSpaceId = id;
    return true;
  });
  state.dismiss.mockResolvedValue(undefined);
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(<SearchSheet />));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function row(label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
async function type(text: string) {
  await act(async () => {
    const field = container.querySelector("input")!;
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("renders inbox chats before typing and closes with the close button", async () => {
  expect(row("Scout, Bot").textContent).toContain("Latest reply");
  expect(row("Team, Group").textContent).toContain("Team reply");
  expect(state.search).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="search-sheet-close"]')!.click(),
  );
  expect(state.back).toHaveBeenCalledOnce();
});
it("leaves out an archived bot that is only in the roster while its chat opens", () => {
  expect(row("Old helper, Bot")).toBeNull();
});
it("debounces typing, renders server hits and preserves the message jump destination", async () => {
  state.search.mockResolvedValue([message, message]);
  await type("matching");
  expect(container.textContent).toContain("Searching…");
  await act(async () => vi.advanceTimersByTime(199));
  expect(state.search).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1));
  expect(state.search).toHaveBeenCalledWith("matching");
  expect(container.querySelectorAll('button[aria-label="Found note, Message"]')).toHaveLength(1);
  expect(row("Found note, Message").textContent).toContain("Scout: A matching line");
  await act(async () => row("Found note, Message").click());
  expect(state.selectSpace).toHaveBeenCalledWith("space-a");
  expect(state.dismiss).toHaveBeenCalledOnce();
  expect(state.replace).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { botId: "bot-a", name: "Scout", messageId: "message-a" },
  });
  expect(state.dismiss.mock.invocationCallOrder[0]).toBeLessThan(
    state.replace.mock.invocationCallOrder[0]!,
  );
});
it("keeps local name matching and does not duplicate conversation hits", async () => {
  state.search.mockResolvedValue([{ ...message, kind: "conversation", title: "Scout" }]);
  await type("Scout");
  await act(async () => vi.advanceTimersByTime(200));
  expect(container.querySelectorAll('button[aria-label="Scout, Bot"]')).toHaveLength(1);
  expect(row("Team, Group")).toBeNull();
});
it("opens a group after switching spaces and keeps the sheet on switch failure", async () => {
  state.selectSpace.mockResolvedValueOnce(false);
  await act(async () => row("Team, Group").click());
  expect(state.alert).toHaveBeenCalled();
  expect(state.replace).not.toHaveBeenCalled();
  await act(async () => row("Team, Group").click());
  expect(state.selectSpace).toHaveBeenCalledWith("space-b");
  expect(state.replace).toHaveBeenCalledWith({
    pathname: "/group-thread",
    params: { groupId: "group-a", name: "Team" },
  });
});
it("ignores stale server responses and restores chats when cleared", async () => {
  let resolve!: (hits: (typeof message)[]) => void;
  state.search.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await type("first");
  await act(async () => vi.advanceTimersByTime(200));
  await type("second");
  await act(async () => vi.advanceTimersByTime(200));
  expect(container.textContent).toContain("No results");
  await act(async () => resolve([message]));
  expect(row("Found note, Message")).toBeNull();
  await type("");
  expect(row("Scout, Bot")).not.toBeNull();
});
it.each([
  ["conversation", "Bot"],
  ["message", "Message"],
  ["file", "File"],
  ["link", "Link"],
  ["routine", "Routine"],
] as const)("labels %s hits", (kind, label) => {
  expect(searchKindLabel({ ...message, kind })).toBe(label);
});

it("retries focus after the sheet attaches and keeps the native search keyboard options", () => {
  const field = container.querySelector("input")!;
  const focus = vi.spyOn(field, "focus");
  act(() => vi.advanceTimersByTime(350));
  expect(focus).toHaveBeenCalledOnce();
  expect(JSON.parse(field.dataset.keyboard!)).toMatchObject({
    autoFocus: true,
    autoCorrect: false,
    autoCapitalize: "none",
    returnKeyType: "search",
    keyboardAppearance: "dark",
    clearButtonMode: "while-editing",
    placeholder: "Search",
  });
});

it("opens an inbox bot with the home thread destination", async () => {
  await act(async () => row("Scout, Bot").click());
  expect(state.selectSpace).toHaveBeenCalledWith("space-a");
  expect(state.replace).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { botId: "bot-a", name: "Scout" },
  });
});

it("clears the Android field and restores inbox chats", async () => {
  state.platform.OS = "android";
  await type("no match");
  await act(async () => row("Clear").click());
  expect(container.querySelector("input")!.value).toBe("");
  expect(row("Scout, Bot")).not.toBeNull();
});

it.each(["space switch", "keyboard dismiss"] as const)(
  "cancels navigation when closed during a pending %s",
  async (stage) => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    if (stage === "space switch") {
      state.selectSpace.mockImplementationOnce(async (id: string) => {
        state.spaceId = id;
        await pending;
        state.persistedSpaceId = id;
        return true;
      });
    } else {
      state.dismiss.mockReturnValueOnce(pending);
    }
    const focus = vi.spyOn(container.querySelector("input")!, "focus");
    await act(async () => row("Team, Group").click());
    // A second tap must not start another attempt while the first is pending.
    await act(async () => row("Scout, Bot").click());
    expect(state.selectSpace).toHaveBeenCalledOnce();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="search-sheet-close"]')!.click(),
    );
    await act(async () => resolve());
    act(() => vi.advanceTimersByTime(350));
    expect(focus).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.spaceId).toBe("space-a");
    expect(state.persistedSpaceId).toBe("space-a");
    if (stage === "space switch") expect(state.dismiss).not.toHaveBeenCalled();
  },
);

it.each(
  ["beforeRemove", "blur", "unmount"].flatMap((event) =>
    ["space switch", "keyboard dismiss"].map((stage) => ({ event, stage })),
  ),
)("cancels pending $stage on $event and restores the space", async ({ event, stage }) => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  if (stage === "space switch") {
    state.selectSpace.mockImplementationOnce(async (id: string) => {
      state.spaceId = id;
      await pending;
      state.persistedSpaceId = id;
      return true;
    });
  } else {
    state.dismiss.mockReturnValueOnce(pending);
  }
  await act(async () => row("Team, Group").click());
  act(() => {
    if (event === "unmount") root.unmount();
    else state.lifecycle.get(event)!();
  });
  await act(async () => resolve());
  expect(state.replace).not.toHaveBeenCalled();
  expect(state.spaceId).toBe("space-a");
  expect(state.persistedSpaceId).toBe("space-a");
});

it("keeps the selected space when successful navigation removes the sheet", async () => {
  state.replace.mockImplementationOnce(() => state.lifecycle.get("beforeRemove")!());
  await act(async () => row("Team, Group").click());
  expect(state.replace).toHaveBeenCalledOnce();
  expect(state.spaceId).toBe("space-b");
  expect(state.persistedSpaceId).toBe("space-b");
});

it.each(["space-c", "space-b"])(
  "does not restore over a newer pending selection of %s after closing during keyboard dismissal",
  async (nextSpace) => {
    let dismiss!: () => void;
    state.dismiss.mockReturnValueOnce(new Promise<void>((resolve) => (dismiss = resolve)));
    await act(async () => row("Team, Group").click());
    expect(state.spaceId).toBe("space-b");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="search-sheet-close"]')!.click(),
    );

    let finishCleanup!: () => void;
    state.selectSpace.mockImplementationOnce(async (id: string) => {
      await new Promise<void>((resolve) => (finishCleanup = resolve));
      state.spaceId = id;
      state.persistedSpaceId = id;
      return true;
    });
    const homeSelection = selectSpace(nextSpace);
    // Home has started selecting, but storage cleanup still leaves B in memory.
    expect(state.spaceId).toBe("space-b");
    await act(async () => dismiss());
    expect(state.selectSpace.mock.calls).toEqual([["space-b"], [nextSpace]]);
    expect(state.replace).not.toHaveBeenCalled();
    await act(async () => {
      finishCleanup();
      expect(await homeSelection).toBe(true);
    });
    expect(state.spaceId).toBe(nextSpace);
    expect(state.persistedSpaceId).toBe(nextSpace);
    expect(state.alert).not.toHaveBeenCalled();
  },
);

it.each(
  ["space switch", "keyboard dismiss"].flatMap((stage) =>
    ["space-c", "space-b"].map((nextSpace) => ({ stage, nextSpace })),
  ),
)(
  "skips stale navigation after a newer pending $nextSpace selection during $stage",
  async ({ stage, nextSpace }) => {
    let finishOpen!: () => void;
    const pending = new Promise<void>((resolve) => (finishOpen = resolve));
    if (stage === "space switch") {
      state.selectSpace.mockImplementationOnce(async (id: string) => {
        state.spaceId = id;
        await pending;
        state.persistedSpaceId = id;
        return true;
      });
    } else {
      state.dismiss.mockReturnValueOnce(pending);
    }
    await act(async () => row("Team, Group").click());

    let finishCleanup!: () => void;
    state.selectSpace.mockImplementationOnce(async (id: string) => {
      await new Promise<void>((resolve) => (finishCleanup = resolve));
      state.spaceId = id;
      state.persistedSpaceId = id;
      return true;
    });
    const homeSelection = selectSpace(nextSpace);
    // The newer request owns the selection even while B remains active.
    expect(state.spaceId).toBe("space-b");
    await act(async () => finishOpen());
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.selectSpace.mock.calls).toEqual([["space-b"], [nextSpace]]);
    expect(state.alert).not.toHaveBeenCalled();
    if (stage === "space switch") expect(state.dismiss).not.toHaveBeenCalled();
    await act(async () => {
      finishCleanup();
      expect(await homeSelection).toBe(true);
    });
    expect(state.spaceId).toBe(nextSpace);
    expect(state.persistedSpaceId).toBe(nextSpace);

    // The focused sheet must allow another row tap after aborting the stale open.
    await act(async () => row("Team, Group").click());
    expect(state.replace).toHaveBeenCalledOnce();
    expect(state.selectSpace.mock.calls).toEqual([["space-b"], [nextSpace], ["space-b"]]);
  },
);

it.each(["session", "server", "selection"])(
  "does not restore a cancelled attempt over a newer %s",
  async (changed) => {
    let resolve!: () => void;
    state.dismiss.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    await act(async () => row("Team, Group").click());
    act(() => state.lifecycle.get("blur")!());
    if (changed === "session") state.generation++;
    else if (changed === "server") state.apiBase = "https://other.example.test";
    else state.spaceId = "space-c";
    await act(async () => resolve());
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.selectSpace).toHaveBeenCalledOnce();
  },
);
