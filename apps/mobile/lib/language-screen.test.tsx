// @vitest-environment jsdom

import { setItemAsync } from "expo-secure-store";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Language from "../app/(settings)/language";
import * as i18n from "./i18n";
import { UI_LOCALE_LABELS, UI_LOCALE_STORAGE_KEY, UI_LOCALES } from "./ui-locale";

vi.mock("expo-secure-store", () => ({ setItemAsync: vi.fn() }));
vi.mock("./ui-direction", () => ({ applyMobileUiDirection: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios }: { ios: string }) => <i data-symbol={ios} />,
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Text: View,
    Switch: () => null,
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ fontScale: 1 }),
    Pressable: (props: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
      accessibilityState?: { selected?: boolean };
    }) => (
      <button
        type="button"
        aria-label={props.accessibilityLabel}
        aria-pressed={props.accessibilityState?.selected}
        disabled={props.disabled}
        onClick={props.onPress}
      >
        {props.children}
      </button>
    ),
  };
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(setItemAsync).mockReset();
  i18n.resetI18nForTests();
  vi.spyOn(i18n, "setUiLocale");
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  i18n.resetI18nForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function row(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  return button!;
}

function expectSelected(label: string) {
  expect(container.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);
  expect(row(label).getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelectorAll('[data-symbol="checkmark"]')).toHaveLength(1);
  expect(row(label).querySelector('[data-symbol="checkmark"]')).not.toBeNull();
}

it.each(["ru", "de"] as const)(
  "saves and selects %s when its language row is pressed",
  async (locale) => {
    let finishSave!: () => void;
    vi.mocked(setItemAsync).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    await act(async () => root.render(<Language />));
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(
      UI_LOCALES.map((code) => UI_LOCALE_LABELS[code]),
    );
    expectSelected("English");

    await act(async () => row(UI_LOCALE_LABELS[locale]).click());
    expect(i18n.setUiLocale).toHaveBeenCalledExactlyOnceWith(locale);
    expect(setItemAsync).toHaveBeenCalledExactlyOnceWith(UI_LOCALE_STORAGE_KEY, locale);
    expect(i18n.getActiveUiLocale()).toBe("en");
    expectSelected("English");
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);

    await act(async () => {
      finishSave();
      await vi.mocked(i18n.setUiLocale).mock.results[0]!.value;
    });
    expect(i18n.getActiveUiLocale()).toBe(locale);
    expectSelected(UI_LOCALE_LABELS[locale]);
    expect(row("English").getAttribute("aria-pressed")).toBe("false");
    expect([...container.querySelectorAll("button")].every((button) => !button.disabled)).toBe(
      true,
    );
  },
);
