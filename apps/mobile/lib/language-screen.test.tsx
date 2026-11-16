// @vitest-environment jsdom

import { APP_LOCALE_LABELS } from "@rakazo/core";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { setItemAsync } from "expo-secure-store";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Language from "../app/(settings)/language";
import { rpc } from "./api";
import * as i18n from "./i18n";
import { resumeLiveNotifications } from "./live-notifications";
import { UI_LOCALE_STORAGE_KEY, UI_LOCALES } from "./ui-locale";

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
const scope = vi.hoisted(() => ({ spaceId: "space-1" }));
vi.mock("./api", () => ({
  currentApiBase: () => "https://rakazo.test",
  rpc: vi.fn(async () => ({})),
  selectedSpaceId: () => scope.spaceId,
  captureApiRequestContext: async (spaceId: string | null = scope.spaceId) => ({
    apiBase: "https://rakazo.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => 1,
  loadSessionToken: async () => "token",
}));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn(async () => undefined) }));
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
    Platform: { OS: "ios" },
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

/** What every write carries: the server, session and space its save was started in. */
const pinned = {
  requestContext: {
    apiBase: "https://rakazo.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-1" },
  },
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(setItemAsync).mockReset();
  vi.mocked(resumeLiveNotifications).mockClear();
  vi.mocked(rpc).mockClear();
  scope.spaceId = "space-1";
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

async function press(label: string) {
  await act(async () => row(label).click());
}
const rowsDisabled = () =>
  [...container.querySelectorAll("button")].map((button) => button.disabled);

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

it.each(["ru", "de", "zh-TW"] as const)(
  "saves and selects %s when its language row is pressed",
  async (locale) => {
    let finishSave!: Deferred;
    vi.mocked(setItemAsync).mockImplementation(() => {
      finishSave = deferred();
      return finishSave.promise;
    });
    await act(async () => root.render(<Language />));
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(
      UI_LOCALES.map((code) => APP_LOCALE_LABELS[code]),
    );
    expectSelected("English");

    await press(APP_LOCALE_LABELS[locale]);
    expect(i18n.setUiLocale).toHaveBeenCalledExactlyOnceWith(locale);
    expect(setItemAsync).toHaveBeenCalledExactlyOnceWith(UI_LOCALE_STORAGE_KEY, locale);
    expect(i18n.getActiveUiLocale()).toBe("en");
    expectSelected("English");
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);

    await act(async () => {
      finishSave.resolve();
      await vi.mocked(i18n.setUiLocale).mock.results[0]!.value;
    });
    expect(i18n.getActiveUiLocale()).toBe(locale);
    expect(resumeLiveNotifications).toHaveBeenCalledWith("https://rakazo.test", "token", "space-1");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("preferences/update", { locale }, pinned);
    expectSelected(APP_LOCALE_LABELS[locale]);
    expect(row("English").getAttribute("aria-pressed")).toBe("false");
    expect([...container.querySelectorAll("button")].every((button) => !button.disabled)).toBe(
      true,
    );
  },
);

/** Holds the change open, so a test decides when and how it ends. */
function holdChange() {
  let finish!: (outcome?: Error) => void;
  vi.mocked(i18n.setUiLocale).mockImplementationOnce(
    (locale) =>
      new Promise((resolve, reject) => {
        finish = (outcome) => {
          if (outcome) return reject(outcome);
          i18n.resetI18nForTests(locale);
          resolve(locale);
        };
      }),
  );
  return async (outcome?: Error) => {
    await act(async () => finish(outcome));
  };
}

it("does not start a second change while one runs", async () => {
  const finish = holdChange();
  await act(async () => root.render(<Language />));
  await press("Deutsch");
  expect(rowsDisabled()).not.toContain(false);
  await press("Deutsch");
  await press("English");
  expect(i18n.setUiLocale).toHaveBeenCalledExactlyOnceWith("de");

  await finish();
  expectSelected("Deutsch");
  expect(rowsDisabled()).not.toContain(true);
});

it("shows a failed change, and clears it when the next one starts", async () => {
  let finish = holdChange();
  await act(async () => root.render(<Language />));
  await press("Deutsch");
  await finish(new Error("no storage"));
  expect(container.textContent).toContain("Could not change language");
  expectSelected("English");
  expect(rowsDisabled()).not.toContain(true);

  finish = holdChange();
  await press("Deutsch");
  expect(container.textContent).not.toContain("Could not change language");
  await finish();
  expectSelected("Deutsch");
  expect(container.textContent).not.toContain("Could not change language");
});

it("keeps the new language, with no error, when what follows the change fails", async () => {
  vi.mocked(resumeLiveNotifications).mockRejectedValueOnce(new Error("offline"));
  vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<Language />));
  await press("Deutsch");
  expectSelected("Deutsch");
  expect(container.textContent).not.toContain("Could not change language");
  expect(rowsDisabled()).not.toContain(true);
});

it("holds the rows for a change that fails after another space was selected, then says so", async () => {
  const finish = holdChange();
  await act(async () => root.render(<Language />));
  await press("Deutsch");
  scope.spaceId = "space-2";
  await act(async () => root.render(<Language />));
  expect(rowsDisabled()).not.toContain(false);
  await press("English");
  expect(i18n.setUiLocale).toHaveBeenCalledExactlyOnceWith("de");

  await finish(new Error("no storage"));
  expect(container.textContent).toContain("Could not change language");
  expect(rowsDisabled()).not.toContain(true);
});

it("leaves a later visit alone when a change fails after the screen has gone", async () => {
  const finish = holdChange();
  await act(async () => root.render(<Language />));
  await press("Deutsch");
  await act(async () => root.render(<div />));
  await finish(new Error("no storage"));

  await act(async () => root.render(<Language />));
  expect(container.textContent).not.toContain("Could not change language");
  expect(rowsDisabled()).not.toContain(true);
  expectSelected("English");
});
