// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import type { ComponentType, CSSProperties, ReactNode } from "react";
import * as React from "react";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { expect, it, vi } from "vitest";

const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/index.tsx", testFileUrl), "utf8");
function evaluate(code: string, scope: Record<string, unknown>) {
  const compiled = ts.transpileModule(code, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(scope), compiled)(...Object.values(scope));
}

it.each([false, true])(
  "hides the index header on every unfold and restores compact controls (initial split: %s)",
  (initialSplit) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let split = initialSplit;
    let options: Record<string, any> = { headerShown: false };
    const navigation = {
      setOptions: vi.fn((next) => {
        options = { ...options, ...next };
      }),
    };
    const action = vi.fn();
    const scope = {
      React,
      useLayoutEffect,
      useNavigation: () => navigation,
      navigation,
      useSplitView: () => ({ split }),
      useSafeAreaInsets: () => ({ top: 20, bottom: 30, left: 0, right: 12 }),
      useI18n: () => ({ t: (text: string) => text }),
      useThemedStyles: () => ({}),
      createHomeStyles: () => ({}),
      View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
      ready: true,
      hasSession: true,
      initials: "A",
      activityMode: false,
      toggleActivityMode: action,
      runCreateAction: action,
      router: { push: action },
      t: (text: string) => text,
      locale: "en",
    };
    // Run the real Home header effect on mount, including its embedded guard.
    const headerStart = source.indexOf("  useLayoutEffect(() => {\n    if (!nativeHeader)");
    const header = source.slice(headerStart, source.indexOf("  const openBot =", headerStart));
    const nativeHeader = source.match(/ {2}const nativeHeader = .*;/)![0];
    const HomeSession = evaluate(
      `return function HomeSession({ embedded = false }) {
        ${nativeHeader}
        ${header}
        return <div>{embedded ? "Embedded inbox" : "Compact inbox"}</div>;
      };`,
      { ...scope, iosAtLeast: () => true },
    );
    const { HomeRoute, InboxPane } = evaluate(
      `${source.slice(source.indexOf("export default function HomeRoute"), source.indexOf("function HomeSession("))}
       return { HomeRoute, InboxPane };`.replace(/export default |export /g, ""),
      { ...scope, HomeSession },
    ) as { HomeRoute: ComponentType; InboxPane: ComponentType };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      for (const wide of [initialSplit, false, true, false, true]) {
        split = wide;
        act(() =>
          root.render(
            <>
              <InboxPane />
              <HomeRoute />
            </>,
          ),
        );
        expect(container.textContent).toContain("Embedded inbox");
        expect(options.headerShown).toBe(!wide);
        if (!wide) {
          expect(
            options.unstable_headerLeftItems().map((item: { label: string }) => item.label),
          ).toEqual(["Account"]);
          expect(
            options.unstable_headerRightItems().map((item: { label: string }) => item.label),
          ).toEqual(["Activity", "Search", "Create"]);
        }
      }
      const calls = navigation.setOptions.mock.calls.length;
      act(() => root.render(<InboxPane />));
      expect(navigation.setOptions).toHaveBeenCalledTimes(calls);
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("shows a translated, safe-area-centred placeholder only in the split pane", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const t = vi.fn(() => "Kies een chat");
  const insets = { top: 20, bottom: 30, left: 0, right: 12 };
  const scope = {
    React,
    useLayoutEffect,
    useNavigation: () => ({ setOptions: vi.fn() }),
    useSplitView: () => ({ split: true }),
    useSafeAreaInsets: () => insets,
    useI18n: () => ({ t }),
    useThemedStyles: () =>
      evaluate(
        `${source.slice(source.indexOf("function createHomeStyles()"))}\nreturn createHomeStyles();`,
        {
          mobileTokens: () => ({}),
          StyleSheet: { create: (styles: unknown) => styles },
          native: { secondaryLabel: "gray" },
          typeScale,
          fontWeight,
          INBOX_ROW: {},
          COMPACT_INBOX_ROW: {},
        },
      ),
    createHomeStyles: () => ({}),
    View: ({ children, style }: { children?: ReactNode; style: CSSProperties[] }) => (
      <div style={Object.assign({}, ...[style].flat())}>{children}</div>
    ),
    Text: ({ children, style }: { children?: ReactNode; style: CSSProperties }) => (
      <span style={style}>{children}</span>
    ),
    HomeSession: () => null,
  };
  const HomeRoute = evaluate(
    `${source.slice(source.indexOf("export default function HomeRoute"), source.indexOf("/** The chat list beside"))}\nreturn HomeRoute;`.replace(
      "export default ",
      "",
    ),
    scope,
  ) as ComponentType;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<HomeRoute />));
    expect(t).toHaveBeenCalledWith("Pick a chat");
    expect(container.textContent).toBe("Kies een chat");
    const pane = container.firstElementChild as HTMLElement;
    expect(pane.style.alignItems).toBe("center");
    expect(pane.style.justifyContent).toBe("center");
    expect(pane.style.paddingTop).toBe("20px");
    expect(pane.style.paddingBottom).toBe("30px");
    expect(pane.style.paddingRight).toBe("12px");
    expect(container.querySelector("span")!.style.color).toBe("gray");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
