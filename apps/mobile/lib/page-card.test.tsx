// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  detail: null as unknown,
  runtimeFails: false,
  pressed: [] as unknown[],
  press: undefined as (() => void) | undefined,
}));

vi.mock("react-native", () => ({
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => {
    host.press = disabled ? undefined : onPress;
    return createElement("div", {}, children);
  },
  Text: ({ children }: { children?: ReactNode }) => createElement("p", {}, children),
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("react-native-svg", () => ({
  default: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: (href: unknown) => host.pressed.push(href) }),
}));
vi.mock("@rakazo/chat-ui/native", () => ({ PageIcon: () => null }));
vi.mock("../components/sandboxed-html-preview", () => ({
  SandboxedHtmlPreview: () => createElement("iframe"),
}));
vi.mock("./api", () => ({ currentApiBase: () => "https://app.example", rpc: vi.fn() }));
vi.mock("./session", () => ({ registerSessionDiskCache: () => undefined }));
vi.mock("./page-runtime", () => ({ loadPageRuntime: async () => "" }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("./page-card-detail", () => ({ usePageCardDetail: () => host.detail }));
vi.mock("./pages", async (original) => ({
  ...(await original<typeof import("./pages")>()),
  pageDocument: async () => {
    if (host.runtimeFails) throw new Error("Page runtime returned 503");
    return "<p>page</p>";
  },
}));

const { PageCard } = await import("../components/pages/page-card");

async function card() {
  const container = document.createElement("div");
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () =>
    root.render(
      createElement(PageCard, {
        block: { kind: "page", pageId: "page-1", version: 1, title: "Plan" },
        messageId: "m1",
      }),
    ),
  );
  return { container, unmount: () => act(() => root.unmount()) };
}

it("says a preview could not load instead of showing a blank card, and still opens the page", async () => {
  host.detail = { id: "page-1", title: "Plan", code: "code", currentVersion: 1 };
  host.runtimeFails = true;
  const failed = await card();
  expect(failed.container.textContent).toContain("This page couldn't load");
  host.press?.();
  expect(host.pressed).toEqual([{ pathname: "/page", params: { pageId: "page-1" } }]);
  failed.unmount();

  // A page whose details could not be read says the same.
  host.detail = "failed";
  const unread = await card();
  expect(unread.container.textContent).toContain("This page couldn't load");
  unread.unmount();

  host.detail = { id: "page-1", title: "Plan", code: "code", currentVersion: 1 };
  host.runtimeFails = false;
  const shown = await card();
  expect(shown.container.textContent).not.toContain("couldn't load");
  shown.unmount();
});
