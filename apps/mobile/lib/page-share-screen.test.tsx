// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  server: { visibility: "private" as "private" | "link", shareUrl: null as string | null },
  /** The server makes the change, then the connection drops before its answer arrives. */
  loseAnswer: false,
  readFails: false,
  owner: { name: "RJ", image: null as string | null },
  sent: [] as string[],
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Image: () => null,
  Platform: { OS: "ios" },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  Share: { share: async () => undefined },
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children }: { children?: ReactNode }) => createElement("p", {}, children),
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-web-browser", () => ({ openBrowserAsync: async () => undefined }));
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({ pageId: "page-1" }) }));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios }: { ios: string }) => createElement("i", { "data-symbol": ios }),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress, "data-title": label }, label),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => createElement("section", {}, children),
  SettingsRow: ({
    title,
    onPress,
    accessibilityState,
    leading,
    detail,
  }: {
    title: string;
    detail?: string;
    onPress?: () => void;
    accessibilityState?: { checked?: boolean };
    leading?: ReactNode;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        onClick: onPress,
        "data-title": title,
        "data-detail": detail,
        "aria-checked": accessibilityState?.checked,
      },
      leading,
      title,
    ),
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key),
  }),
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./session", () => ({ registerSessionDiskCache: () => undefined }));
vi.mock("./page-runtime", () => ({ loadPageRuntime: async () => "" }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc: vi.fn(async (proc: string, input: { visibility?: "private" | "link"; link?: true }) => {
    if (proc === "pages/get") {
      if (host.readFails) throw new TypeError("Network request failed");
      // Like the server: the link only when asked for.
      const shareUrl = input.link === true ? host.server.shareUrl : null;
      return { id: "page-1", title: "Plan", owner: host.owner, ...host.server, shareUrl };
    }
    if (proc === "pages/setVisibility") {
      host.sent.push(input.visibility!);
      // Each turn-on issues a new link.
      host.server = {
        visibility: input.visibility!,
        shareUrl:
          input.visibility === "link" ? `https://rakazo.example/p/${host.sent.length}` : null,
      };
      if (host.loseAnswer) throw new TypeError("Network request failed");
      return { ...host.server };
    }
    throw new Error(`unexpected ${proc}`);
  }),
}));

const { default: PageShareScreen } = await import("../app/page-share");

async function sheet() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(PageShareScreen)));
  const row = (title: string) => container.querySelector<HTMLElement>(`[data-title="${title}"]`);
  const press = (title: string) => act(async () => row(title)!.click());
  const checked = () =>
    ["Only you", "Anyone with the link"].filter(
      (title) => row(title)?.getAttribute("aria-checked") === "true",
    );
  const text = () => container.textContent ?? "";
  return { root, row, press, checked, text };
}

it("shows what the server has after a lost answer, unknown if it can't say, and can always turn the link off", async () => {
  host.server = { visibility: "private", shareUrl: null };
  const { root, row, press, checked, text } = await sheet();
  expect(checked()).toEqual(["Only you"]);
  // A choice says only what its title does not.
  expect([row("Only you")?.dataset.detail, row("Anyone with the link")?.dataset.detail]).toEqual([
    undefined,
    "No sign-in needed",
  ]);

  // Turned on with the answer lost: asked again, the server says the link is on.
  host.loseAnswer = true;
  await press("Anyone with the link");
  expect(checked()).toEqual(["Anyone with the link"]);
  expect(row("Copy link")).not.toBeNull();
  expect(text()).toContain("Could not change who can view this page. Try again.");

  // Turned off with the answer lost and the server out of reach: neither choice is claimed.
  host.readFails = true;
  await press("Only you");
  expect(host.server.visibility).toBe("private");
  expect(checked()).toEqual([]);
  expect(row("Copy link")).toBeNull();

  // Only you still sends, even though that was the last choice made.
  host.loseAnswer = false;
  host.readFails = false;
  await press("Only you");
  expect(host.sent).toEqual(["link", "private", "private"]);
  expect(checked()).toEqual(["Only you"]);
  expect(text()).not.toContain("Could not change");
  // Turning the link on is never sent again on its own.
  expect(host.sent.filter((each) => each === "link")).toHaveLength(1);
  await act(async () => root.unmount());
});

it("says a page that could not be read in the user's words, and Try again reads it again", async () => {
  host.server = { visibility: "link", shareUrl: "https://rakazo.example/p/1" };
  host.readFails = true;
  const { root, row, press, checked, text } = await sheet();
  expect(text()).toBe("Could not reach the serverTry again");
  host.readFails = false;
  await press("Try again");
  expect(checked()).toEqual(["Anyone with the link"]);
  expect(row("Copy link")).not.toBeNull();
  await act(async () => root.unmount());
});

it("names an unnamed owner You, and starts an initial at a letter rather than an emoji", async () => {
  host.server = { visibility: "private", shareUrl: null };
  host.owner = { name: "", image: null };
  const first = await sheet();
  expect(first.row("You")?.textContent).toBe("YYou");
  await act(async () => first.root.unmount());
  host.owner = { name: "🦊 kit", image: null };
  const second = await sheet();
  expect(second.text()).toContain("K🦊 kit");
  await act(async () => second.root.unmount());
  host.owner = { name: "RJ", image: null };
});

it("drops the copied mark once the link is turned off, since turning it on issues a new one", async () => {
  host.server = { visibility: "link", shareUrl: "https://rakazo.example/p/1" };
  const { root, row, press } = await sheet();
  const mark = () => row("Copy link")?.querySelector("i")?.getAttribute("data-symbol");
  expect(mark()).toBe("doc.on.doc");
  await press("Copy link");
  expect(mark()).toBe("checkmark");
  await press("Only you");
  await press("Anyone with the link");
  expect(mark()).toBe("doc.on.doc");
  await act(async () => root.unmount());
});
