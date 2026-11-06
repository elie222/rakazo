// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  detail: null as unknown,
  runtimeFails: false,
  pressed: [] as unknown[],
  press: undefined as (() => void) | undefined,
  touch: {} as Record<string, ((event: { nativeEvent: unknown }) => void) | undefined>,
  message: undefined as ((data: string) => void) | undefined,
  opened: [] as string[],
}));

vi.mock("react-native", () => ({
  Pressable: ({
    children,
    onPress,
    onLayout,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
    disabled?: boolean;
  }) => {
    host.press = disabled ? undefined : onPress;
    useEffect(() => onLayout?.({ nativeEvent: { layout: { width: 320 } } }), [onLayout]);
    return createElement("div", {}, children);
  },
  Text: ({ children }: { children?: ReactNode }) => createElement("p", {}, children),
  View: ({
    children,
    onTouchStart,
    onTouchEnd,
  }: {
    children?: ReactNode;
    onTouchStart?: (event: { nativeEvent: unknown }) => void;
    onTouchEnd?: (event: { nativeEvent: unknown }) => void;
  }) => {
    if (onTouchStart) host.touch = { start: onTouchStart, end: onTouchEnd };
    return createElement("div", {}, children);
  },
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
vi.mock("@rakazo/chat-ui/native", () => ({
  PageIcon: () => null,
  useNativeLinkConfirm: () => (url: string) => host.opened.push(url),
}));
vi.mock("../components/sandboxed-html-preview", () => ({
  SandboxedHtmlPreview: ({ onMessage }: { onMessage?: (data: string) => void }) => {
    host.message = onMessage;
    return createElement("iframe");
  },
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
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

it("draws an HTML page whole in the chat instead of the compact preview", async () => {
  host.runtimeFails = false;
  host.detail = {
    id: "page-1",
    title: "Inline",
    code: "<!DOCTYPE html><html><body><h1>x</h1></body></html>",
    format: "html",
    currentVersion: 1,
  };
  const shown = await card();
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  expect(shown.container.querySelector("iframe")).not.toBeNull();
  expect(shown.container.textContent).toContain("Inline");

  // After a tap it opens a web link the page asks for, and never another kind of link.
  const ask = (url: string) =>
    act(() => host.message?.(JSON.stringify({ type: "rakazo-page:open-link", url })));
  const tap = () =>
    act(() => {
      const touch = { pageX: 10, pageY: 10, touches: [{}] };
      host.touch.start?.({ nativeEvent: touch });
      host.touch.end?.({ nativeEvent: { ...touch, touches: [] } });
    });
  await ask("https://example.com/a");
  expect(host.opened).toEqual([]);
  await tap();
  await ask("tel:+15550100");
  await ask("https://example.com/a");
  expect(host.opened).toEqual(["https://example.com/a"]);
  shown.unmount();
});

it("drops a shown preview when a refresh of the page fails", async () => {
  host.runtimeFails = false;
  host.detail = { id: "page-1", title: "Plan", code: "code", currentVersion: 1 };
  const container = document.createElement("div");
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const render = () =>
    act(async () =>
      root.render(
        createElement(PageCard, {
          block: { kind: "page", pageId: "page-1", version: 1, title: "Plan" },
          messageId: "m1",
        }),
      ),
    );
  await render();
  expect(container.querySelector("iframe")).not.toBeNull();

  host.detail = "failed";
  await render();
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.textContent).toContain("This page couldn't load");

  // A newer version whose preview cannot build drops the older one too.
  host.detail = { id: "page-1", title: "Plan", code: "code", currentVersion: 1 };
  await render();
  expect(container.querySelector("iframe")).not.toBeNull();
  host.runtimeFails = true;
  host.detail = { id: "page-1", title: "Plan", code: "code-2", currentVersion: 2 };
  await render();
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.textContent).toContain("This page couldn't load");
  act(() => root.unmount());
});
