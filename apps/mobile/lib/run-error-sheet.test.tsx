// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import * as Clipboard from "expo-clipboard";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunErrorSheet, useRunError } from "../components/run-error-sheet";
import { ThreadErrorNotice } from "../components/thread-error-notice";

const viewProps = vi.hoisted(() => [] as { style?: unknown; accessibilityRole?: string }[]);
vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ width: 402, fontScale: 1 }),
  StyleSheet: { create: (styles: unknown) => styles },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "aria-label": accessibilityLabel },
      children,
    ),
  Modal: ({ children }: { children: ReactNode }) =>
    createElement("dialog", { open: true }, children),
  View: (props: { children: ReactNode; style?: unknown; accessibilityRole?: string }) => {
    viewProps.push(props);
    return createElement("div", null, props.children);
  },
  ScrollView: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("p", null, children),
  Platform: { OS: "ios" },
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({ card: "token-card" }),
  useResolvedAppearance: () => "light",
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    locale: "en",
    t: (key: string, values?: Record<string, string>) =>
      key.replace(/\{(\w+)\}/g, (_, name: string) => values?.[name] ?? name),
  }),
}));

const details =
  '403: {"message":"OpenRouter weekly key limit exceeded; resets 2026-10-21T00:00:00Z"}';
const roots: ReturnType<typeof createRoot>[] = [];
function mount(element: ReactNode) {
  const node = document.createElement("div");
  const root = createRoot(node);
  roots.push(root);
  act(() => root.render(element));
  return node;
}
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.useRealTimers();
});

describe("run error recovery", () => {
  it("removes the upcoming date while the same saved error remains open", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T23:59:59Z"));
    function Probe() {
      return createElement("p", null, useRunError(details)?.summary);
    }
    const node = mount(createElement(Probe));
    expect(node.textContent).toBe("OpenRouter key hit its weekly limit. Resets Oct 21.");
    act(() => vi.advanceTimersByTime(1000));
    expect(node.textContent).toBe("OpenRouter key hit its weekly limit.");
  });
  it("shows useful cause and recovery information before diagnostics, and copies only on request", () => {
    const onConnection = vi.fn();
    const onModel = vi.fn();
    const onClose = vi.fn();
    const node = mount(createElement(RunErrorSheet, { details, onClose, onConnection, onModel }));
    expect(node.textContent).toContain(
      "This bot's reply stopped at its key's weekly limit. Your own key has its own limits.",
    );
    expect(node.textContent).not.toContain("opens connection settings");
    expect(node.textContent).not.toContain("opens this bot's settings");
    expect(node.textContent).not.toContain("403:");
    const click = (label: string) =>
      act(() => {
        Array.from(node.querySelectorAll("button"))
          .find((button) => button.textContent === label)
          ?.click();
      });
    click("Set your own key");
    click("Change model");
    expect(onConnection).toHaveBeenCalledOnce();
    expect(onModel).toHaveBeenCalledOnce();
    click("Technical details");
    expect(node.textContent).toContain("Provider message");
    expect(node.textContent).toContain("403");
    expect(node.textContent).not.toMatch(/[{}"]/);
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    click("Copy");
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(details);
    click("Technical details");
    expect(node.textContent).not.toContain("403:");
    act(() => node.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });
  it.each([
    '404: {"message":"Model unavailable"}',
    "This model's context window is too small. Choose another model.",
  ])("offers model recovery without suggesting a key failure for %s", (details) => {
    const node = mount(
      createElement(RunErrorSheet, {
        details,
        onClose: vi.fn(),
        onConnection: vi.fn(),
        onModel: vi.fn(),
      }),
    );
    expect(node.textContent).toContain("Change model");
    expect(node.textContent).not.toContain("Set your own key");
    expect(node.textContent).not.toContain("your key or a shared key");
  });
  it("omits the reset field after its date passes while the sheet remains open", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T23:59:59Z"));
    const node = mount(
      createElement(RunErrorSheet, { details, onClose: vi.fn(), onConnection: vi.fn() }),
    );
    act(() => {
      Array.from(node.querySelectorAll("button"))
        .find((button) => button.textContent === "Technical details")
        ?.click();
    });
    expect(node.textContent).toContain("Resets");
    act(() => vi.advanceTimersByTime(1000));
    expect(Array.from(node.querySelectorAll("p")).some((p) => p.textContent === "Resets")).toBe(
      false,
    );
  });
  it("does not mount a native modal when closed", () => {
    const node = mount(
      createElement(RunErrorSheet, { details: null, onClose: vi.fn(), onConnection: vi.fn() }),
    );
    expect(node.querySelector("dialog")).toBeNull();
  });
});

describe("inline error card", () => {
  it.each([
    ["403: OpenRouter weekly key limit exceeded", true, true],
    ["401: Unauthorized", true, true],
    ["429: Too many requests", true, true],
    ["404: Model unavailable", false, true],
    ["500: Internal server error", false, false],
  ])("offers only applicable fixes for %s", (details, connection, model) => {
    const onConnection = vi.fn();
    const onModel = vi.fn();
    const onDetails = vi.fn();
    function Notice() {
      const error = useRunError(details, false);
      return createElement(ThreadErrorNotice, {
        error: null,
        summary: error?.summary ?? null,
        resetAt: error?.resetAt,
        onConnection: error?.recovery === "connection" ? onConnection : undefined,
        onModel: error?.recovery ? onModel : undefined,
        onDetails,
      });
    }
    const node = mount(createElement(Notice));
    expect(node.textContent?.includes("Set your own key")).toBe(connection);
    expect(node.textContent?.includes("Change model")).toBe(model);
    expect(node.textContent).toContain("Details");
    if (connection) expect(node.textContent).toContain("Add your own key or pick another model.");
    if (model && !connection) expect(node.textContent).toContain("Choose another model");
    act(() => {
      for (const button of node.querySelectorAll("button")) button.click();
    });
    expect(onDetails).toHaveBeenCalledOnce();
    expect(onConnection).toHaveBeenCalledTimes(connection ? 1 : 0);
    expect(onModel).toHaveBeenCalledTimes(model ? 1 : 0);
  });
  it("puts only future resets in the explanation and expires them while mounted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T23:59:59Z"));
    function Notice() {
      const error = useRunError(details, false);
      return createElement(ThreadErrorNotice, {
        error: null,
        summary: error?.summary ?? null,
        resetAt: error?.resetAt,
        onConnection: vi.fn(),
        onDetails: vi.fn(),
      });
    }
    const node = mount(createElement(Notice));
    expect(node.querySelector("p")?.textContent).not.toContain("Resets");
    expect(node.textContent).toContain("Resets Oct 21.");
    act(() => vi.advanceTimersByTime(1000));
    expect(node.textContent).not.toContain("Resets");
  });
});

it.each([false, true])("keeps history fetch errors visible (provider failure: %s)", (failedRun) => {
  // Exercise the actual screen notice and pinned footer without its native dependencies.
  const testFileUrl = import.meta.url;
  const source = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
  const noticeStart = source.indexOf("  const visibleRunError =");
  const notice = source.slice(noticeStart, source.indexOf("  return (\n    <View", noticeStart));
  const footerStart = source.indexOf("{pinnedNewerCursor === null ? failedSendBubbles : null}");
  const footer = source.slice(footerStart, source.indexOf("</ScrollView>", footerStart));
  const scope = {
    createElement,
    View: "div",
    ThreadErrorNotice,
    showPinnedPage: true,
    pinnedNewerCursor: 10,
    normalizedRunError: failedRun
      ? { summary: "OpenRouter key hit its weekly limit.", recovery: "connection" }
      : null,
    error: "Could not load newer messages",
    showingSaved: false,
    t: (key: string) => key,
    setRunErrorDetailsOpen: vi.fn(),
    openErrorConnection: vi.fn(),
    openErrorModel: vi.fn(),
    snap: { run: { botId: "fixture-bot" } },
    botId: "fixture-bot",
    failedSendBubbles: null,
    workingFooter: null,
    loadingNewer: false,
  };
  const script = ts.transpileModule(`${notice}\nreturn <>{fetchErrorNotice}${footer}</>;`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      jsxFactory: "createElement",
      jsxFragmentFactory: "Fragment",
    },
  }).outputText;
  const render = new Function("Fragment", ...Object.keys(scope), script);
  const node = mount(render("div", ...Object.values(scope)));
  expect(node.textContent).toContain("Could not load newer messages");
  expect(node.textContent).not.toContain("weekly limit");
  expect(node.textContent).not.toContain("Set your own key");
  expect(node.textContent).not.toContain("Change model");
  expect(node.textContent).not.toContain("Details");
});

it("keeps fetch failures outside both native scrolling lists", () => {
  const testFileUrl = import.meta.url;
  const source = ts.createSourceFile(
    "thread.tsx",
    readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let notices = 0;
  function visit(node: ts.Node) {
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "fetchErrorNotice"
    ) {
      notices += 1;
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        const tag = ts.isJsxElement(parent)
          ? parent.openingElement.tagName
          : ts.isJsxSelfClosingElement(parent)
            ? parent.tagName
            : undefined;
        if (tag) expect(tag.getText(source)).not.toMatch(/^(ScrollView|FlatList)$/);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(notices).toBe(1);
});

it("draws the error notice as a filled card without an outline", () => {
  viewProps.length = 0;
  mount(createElement(ThreadErrorNotice, { error: "Run failed", summary: null }));
  const card = viewProps.find((props) => props.accessibilityRole === "alert");
  const style = Object.assign({}, ...[card?.style].flat(2));
  expect(style.backgroundColor).toBe("token-card");
  expect(style).not.toHaveProperty("borderWidth");
  expect(style).not.toHaveProperty("borderColor");
});
