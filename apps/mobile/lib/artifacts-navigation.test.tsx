// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isSettingsLink, openFromSettingsSheet, registerSettingsSheet } from "./settings-sheet";

const testFileUrl = import.meta.url;
const home = readFileSync(new URL("../app/index.tsx", testFileUrl), "utf8");
const account = readFileSync(new URL("../app/(settings)/account.tsx", testFileUrl), "utf8");
function slice(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}
function evaluate(source: string, scope: Record<string, unknown>) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(scope), compiled)(...Object.values(scope));
}
const t = (text: string) => text;
const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const Button = ({
  accessibilityLabel,
  title,
  accessibilityRole,
  chevron,
  disabled,
  onPress,
}: {
  accessibilityLabel?: string;
  title?: string;
  accessibilityRole?: string;
  chevron?: string;
  disabled?: boolean;
  onPress: () => void;
}) => (
  <button
    type="button"
    aria-label={accessibilityLabel}
    role={accessibilityRole}
    data-chevron={chevron}
    disabled={disabled}
    onClick={onPress}
  >
    {title}
  </button>
);
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

it("keeps only Activity, Search and Create in the transparent native home header", () => {
  const setOptions = vi.fn();
  evaluate(slice(home, "  useLayoutEffect(() => {\n    if (!nativeHeader)", "  const openBot ="), {
    useLayoutEffect: (effect: () => void) => effect(),
    nativeHeader: true,
    navigation: { setOptions },
    ready: true,
    hasSession: true,
    initials: "A",
    activityMode: false,
    toggleActivityMode: vi.fn(),
    runCreateAction: vi.fn(),
    router: { push: vi.fn() },
    t,
    locale: "en",
  });
  const options = setOptions.mock.calls[0]![0];
  expect(
    options
      .unstable_headerRightItems()
      .map((item: { accessibilityLabel: string }) => item.accessibilityLabel),
  ).toEqual(["Activity", "Search", "Create"]);
  expect(options.headerTransparent).toBe(true);
  expect(options.headerStyle).toEqual({ backgroundColor: "transparent" });
});

it.each(["android", "ios"])("omits Artifacts from the %s fallback header", (platform) => {
  const header = slice(
    home,
    "      {nativeHeader || onShareSelect ? null : (",
    "      <SelectedChatContext.Provider",
  ).trim();
  const element = evaluate(`return <>${header}</>;`, {
    React,
    nativeHeader: false,
    onShareSelect: undefined,
    View: ({
      children,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      accessibilityLabel?: string;
    }) => <fieldset aria-label={accessibilityLabel}>{children}</fieldset>,
    HeaderButton: Button,
    Text: View,
    NativeSymbol: () => null,
    MenuView: View,
    styles: {},
    insets: { top: 0 },
    columnInsets: { left: 0, right: 0 },
    t,
    router: { push: vi.fn() },
    initials: "A",
    activityMode: false,
    toggleActivityMode: vi.fn(),
    tokens: {},
    Platform: { OS: platform },
    openCreateChooser: vi.fn(),
    appearance: "light",
    runCreateAction: vi.fn(),
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(element));
    expect(
      Array.from(container.querySelectorAll("[aria-label]"), (node) =>
        node.getAttribute("aria-label"),
      ),
    ).toEqual(["Account", "Activity", "Search", "Create"]);
  } finally {
    act(() => root.unmount());
  }
});

it.each([false, true])(
  "keeps account navigation free of server controls (stored owner: %s)",
  (isDeploymentOwner) => {
    const start = account.lastIndexOf(
      "        <SettingsGroup>",
      account.indexOf('title: t("Artifacts")'),
    );
    const group = slice(
      account.slice(start),
      "        <SettingsGroup>",
      "\n\n        <SettingsGroup>",
    );
    const events: string[] = [];
    const unregister = registerSettingsSheet(() => events.push("close"));
    const router = { push: vi.fn((href: string) => events.push(href)) };
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (pending: boolean) =>
      evaluate(`return (${group});`, {
        React,
        SettingsGroup: View,
        SettingsRow: Button,
        t,
        pending,
        me: { isDeploymentOwner },
        router,
        isSettingsLink,
        openFromSettingsSheet,
      });
    try {
      act(() => root.render(render(false)));
      const rows = Array.from(container.querySelectorAll("button"));
      expect(rows.map((row) => row.textContent)).toEqual([
        "Artifacts",
        "Models",
        "Voice",
        "Integrations",
        "AI data sharing",
      ]);
      expect(rows[0]!.getAttribute("role")).toBe("button");
      expect(rows[0]!.dataset.chevron).toBe("right");
      act(() => rows[0]!.click());
      expect(events).toEqual(["close", "/artifacts"]);
      events.length = 0;
      act(() => rows[1]!.click());
      expect(events).toEqual(["/models"]);
      act(() => root.render(render(true)));
      expect(container.querySelector("button")!.disabled).toBe(true);
    } finally {
      act(() => root.unmount());
      unregister();
    }
  },
);
