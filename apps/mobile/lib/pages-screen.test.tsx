// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

type Button = { text: string; onPress?: (value?: string) => void };
type Summary = {
  id: string;
  title: string;
  pinned: boolean;
  visibility: "private" | "link";
  updatedAt: string;
};

const host = vi.hoisted(() => ({
  server: [] as Summary[],
  renameFails: false,
  /** The server makes the change, then the connection drops before its answer arrives. */
  loseAnswer: false,
  listFails: false,
  alert: null as Button[] | null,
  focus: null as (() => void) | null,
  menus: new Map<string, { actions: { id: string }[]; press: (id: string) => void }>(),
  prompt: null as Button[] | null,
  pushed: [] as unknown[],
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Alert: {
    alert: (_title: string, _message: string, buttons: Button[]) => {
      host.alert = buttons;
    },
    prompt: (_title: string, _message: unknown, buttons: Button[]) => {
      host.prompt = buttons;
    },
  },
  Modal: () => null,
  Platform: { OS: "ios" },
  Pressable: () => null,
  ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children }: { children?: ReactNode }) => createElement("p", {}, children),
  TextInput: () => null,
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    title,
    actions,
    onPressAction,
    children,
  }: {
    title: string;
    actions: { id: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => {
    host.menus.set(title, {
      actions,
      press: (id) => onPressAction({ nativeEvent: { event: id } }),
    });
    return createElement("div", {}, children);
  },
}));
vi.mock("@rakazo/chat-ui/native", () => ({ PageIcon: () => null }));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ botId: "b1" }),
  useRouter: () => ({ push: (href: unknown) => host.pushed.push(href) }),
  // On screen once mounted, and again each time a sheet over it is dismissed.
  useFocusEffect: (effect: () => void) => {
    host.focus = effect;
    useEffect(effect, [effect]);
  },
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => createElement("section", {}, children),
  SettingsRow: ({ title, detail }: { title: string; detail?: string }) =>
    createElement("p", {}, `${title} | ${detail ?? ""}`),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./activity", () => ({ formatActivityRelativeTime: () => "now" }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key),
  }),
}));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("./session", () => ({ registerSessionDiskCache: () => undefined }));
vi.mock("./page-runtime", () => ({ loadPageRuntime: async () => "" }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc: vi.fn(async (proc: string, input: Record<string, string>) => {
    const page = host.server.find((each) => each.id === input.pageId);
    if (proc === "pages/list") {
      if (host.listFails) throw new Error("Invalid page list cursor");
      return { items: host.server.map((each) => ({ ...each })), nextCursor: null };
    }
    if (proc === "pages/pin" || proc === "pages/remove") {
      if (proc === "pages/pin") page!.pinned = input.pinned as unknown as boolean;
      else host.server = host.server.filter((each) => each !== page);
      if (host.loseAnswer) throw new TypeError("Network request failed");
      return proc === "pages/pin" ? { ...page } : { ok: true };
    }
    if (proc === "pages/setVisibility") {
      page!.visibility = input.visibility as Summary["visibility"];
      return { visibility: page!.visibility, shareUrl: null };
    }
    if (proc === "pages/rename") {
      if (host.renameFails) throw new Error("offline");
      page!.title = input.title!;
      if (host.loseAnswer) throw new TypeError("Network request failed");
      return { ...page };
    }
    throw new Error(`unexpected ${proc}`);
  }),
}));

const { default: PagesScreen } = await import("../app/pages");
const { setPageVisibility } = await import("./pages");
const { rpc } = await import("./api");

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll("p")].map((row) => row.textContent);
const actions = (title: string) => host.menus.get(title)?.actions.map((action) => action.id);

async function library() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.server = [
    { id: "p1", title: "Plan", pinned: false, visibility: "private", updatedAt: "2026-01-01" },
  ];
  host.menus.clear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(PagesScreen)));
  return { container, root };
}

it("shows a share change made in the sheet once the sheet is dismissed", async () => {
  const { container, root } = await library();
  expect(rows(container)).toEqual(["Plan | now"]);
  expect(actions("Plan")).not.toContain("copy");

  // Share opens the sheet over the list; anyone with the link can view once it is dismissed.
  await act(async () => host.menus.get("Plan")!.press("share"));
  expect(host.pushed.at(-1)).toEqual({ pathname: "/page-share", params: { pageId: "p1" } });
  await setPageVisibility("p1", "link");
  await act(async () => host.focus?.());
  expect(rows(container)).toEqual(["Plan | Shared · now"]);
  expect(actions("Plan")).toContain("copy");

  // And private again.
  await setPageVisibility("p1", "private");
  await act(async () => host.focus?.());
  expect(rows(container)).toEqual(["Plan | now"]);
  expect(actions("Plan")).not.toContain("copy");
  await act(async () => root.unmount());
});

it("renames a page from its menu, keeping it as it was on cancel, an empty name or a failure", async () => {
  const { container, root } = await library();
  const renames = () => vi.mocked(rpc).mock.calls.filter(([proc]) => proc === "pages/rename");
  const rename = async (button: "Cancel" | "Save", value?: string) => {
    host.prompt = null;
    await act(async () => host.menus.get(rows(container)[0]!.split(" | ")[0]!)!.press("rename"));
    await act(async () => host.prompt!.find((each) => each.text === button)!.onPress?.(value));
  };
  vi.mocked(rpc).mockClear();

  await rename("Cancel");
  await rename("Save", "   ");
  await rename("Save", "Plan");
  // Longer than a page title may be: the prompt keeps it rather than saving.
  await rename("Save", "x".repeat(201));
  expect(renames()).toEqual([]);
  expect(rows(container)).toEqual(["Plan | now"]);

  await rename("Save", "  Launch plan ");
  expect(renames()).toEqual([["pages/rename", { pageId: "p1", title: "Launch plan" }]]);
  expect(rows(container)).toEqual(["Launch plan | now"]);

  host.renameFails = true;
  await rename("Save", "Other");
  expect(rows(container)).toEqual(["Could not rename the page.", "Launch plan | now"]);
  host.renameFails = false;
  await act(async () => root.unmount());
});

it("shows what the server has after a rename, pin or delete whose answer was lost", async () => {
  const { container, root } = await library();
  host.loseAnswer = true;
  host.prompt = null;
  await act(async () => host.menus.get("Plan")!.press("rename"));
  await act(async () => host.prompt!.find((each) => each.text === "Save")!.onPress?.("Launch"));
  expect(rows(container)).toEqual(["Could not rename the page.", "Launch | now"]);

  await act(async () => host.menus.get("Launch")!.press("pin"));
  expect(rows(container)).toEqual(["Could not pin the page.", "Launch | now"]);
  // Pinned on the server, so its menu now offers Unpin.
  const pin = host.menus.get("Launch")!.actions.find((action) => action.id === "pin");
  expect(pin).toMatchObject({ title: "Unpin" });

  await act(async () => host.menus.get("Launch")!.press("delete"));
  await act(async () => host.alert!.find((each) => each.text === "Delete")!.onPress?.());
  expect(rows(container)).toEqual(["Pages this bot builds for you appear here."]);
  host.loseAnswer = false;
  await act(async () => root.unmount());
});

it("says a list that could not load in the user's words, and Try again reads it again", async () => {
  host.listFails = true;
  const { container, root } = await library();
  expect(container.textContent).toBe("Could not load pages.Try again");
  host.listFails = false;
  await act(async () => container.querySelector("button")!.click());
  expect(rows(container)).toEqual(["Plan | now"]);
  await act(async () => root.unmount());
});
