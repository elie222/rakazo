// @vitest-environment jsdom

import { normalizeRunError } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunErrorSheet, useRunError } from "../components/run-error-sheet";
import { ThreadErrorNotice, ThreadFetchErrorNotice } from "../components/thread-error-notice";
import { runErrorActionLabel } from "./run-error-presentation";
import { liveEndRunError } from "./thread-window";

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
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./integrations-cache", () => ({ isIntegrationsScopeCurrent: () => true }));
vi.mock("./saved-chats", () => ({ liveSavedChatsScope: async () => null }));
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
    const onPress = vi.fn();
    const onClose = vi.fn();
    const node = mount(
      createElement(RunErrorSheet, { details, onClose, action: { label: "Add Model", onPress } }),
    );
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
    click("Add Model");
    expect(onPress).toHaveBeenCalledOnce();
    expect(node.textContent).not.toContain("Change model");
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
    "This connection's request limit is too small. Choose another model.",
    "The model hit its output limit before finishing its reply.",
  ])("offers model recovery without suggesting a key failure for %s", (details) => {
    const label = runErrorActionLabel((key) => key, normalizeRunError(details));
    expect(label).toBe("Change model");
    const node = mount(
      createElement(RunErrorSheet, {
        details,
        onClose: vi.fn(),
        action: label ? { label, onPress: vi.fn() } : null,
      }),
    );
    expect(node.textContent).toContain("Change model");
    expect(node.textContent).not.toContain("Replace key");
    expect(node.textContent).not.toContain("your key or a shared key");
  });
  it("omits the reset field after its date passes while the sheet remains open", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T23:59:59Z"));
    const node = mount(createElement(RunErrorSheet, { details, onClose: vi.fn() }));
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
    const node = mount(createElement(RunErrorSheet, { details: null, onClose: vi.fn() }));
    expect(node.querySelector("dialog")).toBeNull();
  });
});

describe("inline error card", () => {
  it.each([
    ["403: OpenRouter weekly key limit exceeded", "Add Model"],
    ["401: Unauthorized", "Replace key"],
    ["402: You have no credits remaining.", "Change model"],
    ["404: Model unavailable", "Change model"],
    ["429: Too many requests", null],
    ["500: Internal server error", null],
  ])("offers the one fix for %s", (details, label) => {
    const onPress = vi.fn();
    const onDetails = vi.fn();
    function Notice() {
      const error = useRunError(details, false);
      const actionLabel = error ? runErrorActionLabel((key) => key, error) : null;
      return createElement(ThreadErrorNotice, {
        error: null,
        summary: error?.summary ?? null,
        resetAt: error?.resetAt,
        action: actionLabel ? { label: actionLabel, onPress } : null,
        onDetails,
      });
    }
    const node = mount(createElement(Notice));
    for (const other of ["Add Model", "Replace key", "Change model"]) {
      expect(node.textContent?.includes(other)).toBe(other === label);
    }
    expect(node.textContent).toContain("Details");
    act(() => {
      for (const button of node.querySelectorAll("button")) button.click();
    });
    expect(onDetails).toHaveBeenCalledOnce();
    expect(onPress).toHaveBeenCalledTimes(label ? 1 : 0);
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
        action: { label: "Add Model", onPress: vi.fn() },
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
  const runError = failedRun
    ? { summary: "OpenRouter key hit its weekly limit.", recovery: "connection" as const }
    : null;
  // A pinned page with newer messages still to load.
  const visible = liveEndRunError(runError, 10);
  const node = mount(
    createElement(
      "div",
      null,
      createElement(ThreadErrorNotice, {
        error: null,
        summary: visible?.summary ?? null,
        onDetails: vi.fn(),
        action: visible ? { label: "Add Model", onPress: vi.fn() } : null,
      }),
      createElement(ThreadFetchErrorNotice, {
        error: "Could not load newer messages",
        showingSaved: false,
      }),
    ),
  );
  expect(node.textContent).toContain("Could not load newer messages");
  expect(node.textContent).not.toContain("weekly limit");
  expect(node.textContent).not.toContain("Add Model");
  expect(node.textContent).not.toContain("Details");
});

it("offers provider recovery once the chat reaches its live end", () => {
  const runError = { summary: "OpenRouter key hit its weekly limit.", recovery: "connection" };
  expect(liveEndRunError(runError, null)).toBe(runError);
  expect(liveEndRunError(null, null)).toBeNull();
});

it("says the last loaded messages stay on screen when a refresh fails", () => {
  const node = mount(
    createElement(ThreadFetchErrorNotice, { error: "Network request failed", showingSaved: true }),
  );
  expect(node.textContent).toBe("Couldn't refresh — showing the last loaded messages.");
  expect(
    mount(createElement(ThreadFetchErrorNotice, { error: null, showingSaved: true })).textContent,
  ).toBe("");
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
