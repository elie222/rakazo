// @vitest-environment jsdom

import type { CSSProperties, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "ios" }));

vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
      visible ? <div>{children}</div> : null,
    Platform: platform,
    View,
    ScrollView: ({ children }: { children?: ReactNode }) => (
      <div data-scroll-view="true">{children}</div>
    ),
    Text: ({ children, selectable }: { children?: ReactNode; selectable?: boolean }) => (
      <span data-selectable={selectable}>{children}</span>
    ),
    TextInput: ({
      value,
      editable,
      multiline,
      scrollEnabled,
      style,
    }: {
      value: string;
      editable?: boolean;
      multiline?: boolean;
      scrollEnabled?: boolean;
      style?: CSSProperties[];
    }) => (
      <textarea
        value={value}
        style={Object.assign({}, ...(style ?? []))}
        readOnly={editable === false}
        data-multiline={multiline}
        data-scroll-enabled={scrollEnabled}
      />
    ),
    StyleSheet: { create: <T,>(styles: T) => styles },
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));

import { SelectTextSheet } from "../components/select-text-sheet";

const message = "First line of a reply.\n\nשלום, a second paragraph with مرحبا in it.";
const onClose = vi.fn();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  platform.OS = "ios";
  onClose.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(text: string | null) {
  act(() => root.render(<SelectTextSheet text={text} onClose={onClose} />));
}

it("shows the whole message in a read-only text view on iOS so any range can be selected", () => {
  render(message);

  const view = container.querySelector("textarea");
  expect(view?.value).toBe(message);
  expect(view?.readOnly).toBe(true);
  expect(view?.dataset.multiline).toBe("true");
  expect(container.querySelector("span")).toBeNull();
});

it("removes the iOS text view's default vertical padding", () => {
  render(message);

  const view = container.querySelector("textarea");
  expect(view?.style.paddingTop).toBe("0px");
  expect(view?.style.paddingBottom).toBe("0px");
});

it("scrolls the sheet rather than the text view, so it opens at the start of the message", () => {
  render(message);

  // A scrolling text view opens scrolled toward its caret at the end of the text.
  const view = container.querySelector("[data-scroll-view] textarea");
  expect(view).not.toBeNull();
  expect((view as HTMLTextAreaElement).dataset.scrollEnabled).toBe("false");
});

it("keeps selectable text on Android, where it already selects ranges", () => {
  platform.OS = "android";
  render(message);

  expect(container.querySelector("textarea")).toBeNull();
  const text = container.querySelector("span");
  expect(text?.textContent).toBe(message);
  expect(text?.dataset.selectable).toBe("true");
});

it("closes from Done", () => {
  render(message);

  act(() => container.querySelector("button")?.click());
  expect(onClose).toHaveBeenCalledOnce();
});
