// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => true) }));

vi.mock("expo-clipboard", () => clipboard);
vi.mock("react-native", () => ({
  Pressable: ({
    accessibilityRole,
    accessibilityLabel,
    onPress,
    style,
    children,
  }: {
    accessibilityRole?: string;
    accessibilityLabel?: string;
    onPress?: () => void;
    style: (state: { pressed: boolean }) => unknown;
    children?: ReactNode;
  }) =>
    createElement(
      "rn-pressable",
      {
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        onClick: onPress,
        "data-style": JSON.stringify(Object.assign({}, ...(style({ pressed: false }) as object[]))),
      },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../lib/native", () => ({ useMobileTokens: () => ({ mutedForeground: "muted" }) }));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios, android, color }: { ios: string; android: string; color: string }) =>
    createElement("native-symbol", {
      "data-ios": ios,
      "data-android": android,
      "data-color": color,
    }),
}));

import { CodeCopyButton } from "../components/code-copy-button";

afterEach(() => {
  vi.useRealTimers();
  clipboard.setStringAsync.mockClear();
});

async function renderButton(code: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<CodeCopyButton code={code} />));
  return {
    button: () => container.querySelector("rn-pressable"),
    symbol: () => container.querySelector("native-symbol"),
    unmount: () => act(async () => root.unmount()),
  };
}

it("is a button named Copy code with the copy symbol", async () => {
  const view = await renderButton("npm test");
  expect(view.button()?.getAttribute("role")).toBe("button");
  expect(view.button()?.getAttribute("aria-label")).toBe("Copy code");
  expect(view.symbol()?.getAttribute("data-ios")).toBe("doc.on.doc");
  expect(view.symbol()?.getAttribute("data-android")).toBe("copy-outline");
  expect(view.symbol()?.getAttribute("data-color")).toBe("muted");
  await view.unmount();
});

it("copies the exact code, shows a check named Copied, then turns back", async () => {
  vi.useFakeTimers();
  const code = "const a = 1;\n\n  return a;";
  const view = await renderButton(code);
  await act(async () => {
    (view.button() as HTMLElement).click();
  });
  expect(clipboard.setStringAsync).toHaveBeenCalledWith(code);
  expect(view.button()?.getAttribute("aria-label")).toBe("Copied");
  expect(view.symbol()?.getAttribute("data-ios")).toBe("checkmark");

  await act(async () => {
    vi.advanceTimersByTime(1999);
  });
  expect(view.button()?.getAttribute("aria-label")).toBe("Copied");
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(view.button()?.getAttribute("aria-label")).toBe("Copy code");
  expect(view.symbol()?.getAttribute("data-ios")).toBe("doc.on.doc");
  await view.unmount();
});

it("stays a copy button when the clipboard refuses", async () => {
  clipboard.setStringAsync.mockRejectedValueOnce(new Error("denied"));
  const view = await renderButton("npm test");
  await act(async () => {
    (view.button() as HTMLElement).click();
  });
  expect(view.button()?.getAttribute("aria-label")).toBe("Copy code");
  expect(view.symbol()?.getAttribute("data-ios")).toBe("doc.on.doc");
  await view.unmount();
});

it("aligns the icon with the code padding inside a 40pt hit target", async () => {
  const view = await renderButton("npm test");
  expect(JSON.parse(view.button()?.getAttribute("data-style") ?? "{}")).toMatchObject({
    width: 40,
    height: 40,
    alignItems: "flex-end",
    paddingRight: 10,
    justifyContent: "center",
  });
  await view.unmount();
});
