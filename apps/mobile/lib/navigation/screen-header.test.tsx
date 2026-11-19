// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScreenHeaderAction } from "./screen-header";
import { useScreenHeader } from "./screen-header";

type Item = {
  type: string;
  label: string;
  variant?: string;
  tintColor?: string;
  disabled: boolean;
  onPress: () => void;
};
type Options = {
  title?: string;
  headerRight?: () => ReactNode;
  unstable_headerRightItems?: () => Item[];
};
const state = vi.hoisted(() => ({
  ios26: false,
  setOptions: vi.fn(),
}));
vi.mock("../native/native-controls", () => ({ iosAtLeast: () => state.ios26 }));
vi.mock("../appearance/appearance", () => ({
  mobileTokens: () => ({ primary: "primary-token", destructive: "destructive-token" }),
}));
vi.mock("expo-router", () => {
  // The same object on every render, as the app's navigation is.
  const navigation = { setOptions: (options: unknown) => state.setOptions(options) };
  return { useNavigation: () => navigation };
});
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    fill,
    prominence,
  }: {
    label: string;
    onPress: () => void;
    disabled: boolean;
    fill: boolean;
    prominence: string;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        // A disabled DOM button would swallow the click; the hook itself must ignore the press.
        "aria-disabled": disabled,
        "data-fill": fill,
        "data-prominence": prominence,
        onClick: onPress,
      },
      label,
    ),
}));

type Header = Parameters<typeof useScreenHeader>[0];
function Screen({ header }: { header: Header }) {
  useScreenHeader(header);
  return null;
}

let container: HTMLDivElement;
let root: Root;
let header: Root;
let headerContainer: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.ios26 = false;
  state.setOptions.mockReset();
  container = document.createElement("div");
  headerContainer = document.createElement("div");
  document.body.append(container, headerContainer);
  root = createRoot(container);
  header = createRoot(headerContainer);
});
afterEach(() => {
  act(() => {
    root.unmount();
    header.unmount();
  });
  container.remove();
  headerContainer.remove();
  vi.unstubAllGlobals();
});

function render(next: Header) {
  act(() => root.render(<Screen header={next} />));
}
/** Every option set so far, merged the way navigation merges them. */
function options(): Options {
  return Object.assign({}, ...state.setOptions.mock.calls.map(([set]) => set));
}
/** The trailing button as Android and older iOS draw it. */
function button() {
  act(() => header.render(options().headerRight?.()));
  return headerContainer.querySelector("button");
}
function item() {
  return options().unstable_headerRightItems?.()[0];
}
const save = (overrides: Partial<ScreenHeaderAction> = {}): ScreenHeaderAction => ({
  label: "Save",
  onPress: () => undefined,
  ...overrides,
});

it("sets the title and a primary action button", () => {
  render({ title: "Notes", action: save() });
  expect(state.setOptions).toHaveBeenCalledTimes(1);
  expect(options().title).toBe("Notes");
  expect(options().unstable_headerRightItems).toBeUndefined();
  const shown = button();
  expect(shown?.textContent).toBe("Save");
  expect(shown?.getAttribute("aria-disabled")).toBe("false");
  expect(shown?.dataset.fill).toBe("false");
  expect(shown?.dataset.prominence).toBe("primary");
});

it("sets a native bar button on iOS 26, styled by its prominence", () => {
  state.ios26 = true;
  render({ title: "Notes", action: save() });
  expect(options().headerRight).toBeUndefined();
  expect(item()).toMatchObject({
    type: "button",
    label: "Save",
    variant: "prominent",
    tintColor: "primary-token",
    disabled: false,
  });

  render({ title: "Notes", action: save({ label: "Remove", prominence: "destructive" }) });
  expect(item()).toMatchObject({ label: "Remove", tintColor: "destructive-token" });
  expect(item()?.variant).toBeUndefined();

  render({ title: "Notes", action: save({ label: "Add rule", prominence: "secondary" }) });
  expect(item()).toMatchObject({ label: "Add rule", disabled: false });
  expect(item()?.variant).toBeUndefined();
  expect(item()?.tintColor).toBeUndefined();
});

it("sets the header again when the title, the label, disabled or busy change", () => {
  render({ title: "Notes", action: save() });
  render({ title: "Ideas", action: save() });
  expect(state.setOptions).toHaveBeenCalledTimes(2);
  expect(options().title).toBe("Ideas");

  render({ title: "Ideas", action: save({ disabled: true }) });
  expect(state.setOptions).toHaveBeenCalledTimes(3);
  expect(button()?.getAttribute("aria-disabled")).toBe("true");

  render({ title: "Ideas", action: save({ busy: true }) });
  render({ title: "Ideas", action: save({ disabled: true, busy: true }) });
  // Busy looks the same as disabled, so going from one to the other, or to both, sets nothing.
  expect(state.setOptions).toHaveBeenCalledTimes(3);
  expect(button()?.getAttribute("aria-disabled")).toBe("true");

  render({ title: "Ideas", action: save() });
  expect(state.setOptions).toHaveBeenCalledTimes(4);
  expect(button()?.getAttribute("aria-disabled")).toBe("false");

  render({ title: "Ideas", action: save({ label: "Saving…" }) });
  expect(state.setOptions).toHaveBeenCalledTimes(5);
  expect(button()?.textContent).toBe("Saving…");
});

it("runs the latest handler without setting the header again when only the handler changes", () => {
  const first = vi.fn();
  const latest = vi.fn();
  render({ title: "Notes", action: save({ onPress: first }) });
  const shown = button();
  render({ title: "Notes", action: save({ onPress: latest }) });
  expect(state.setOptions).toHaveBeenCalledTimes(1);

  // The button drawn before the handler changed is the one still in the header.
  act(() => shown?.click());
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
});

it.each([
  ["disabled", { disabled: true }],
  ["busy", { busy: true }],
])("ignores a press while %s, on either kind of button", (_name, inactive) => {
  const onPress = vi.fn();
  render({ action: save({ onPress }) });
  const enabled = button();
  render({ action: save({ onPress, ...inactive }) });
  // A press on the button from before it turned inactive, and one on the inactive button.
  act(() => enabled?.click());
  act(() => button()?.click());
  expect(onPress).not.toHaveBeenCalled();

  state.ios26 = true;
  render({ title: "Notes", action: save({ onPress, ...inactive }) });
  expect(item()?.disabled).toBe(true);
  item()?.onPress();
  expect(onPress).not.toHaveBeenCalled();

  render({ title: "Notes", action: save({ onPress }) });
  item()?.onPress();
  expect(onPress).toHaveBeenCalledTimes(1);
});

it("clears its button when the action is null, and brings it back", () => {
  render({ title: "Notes", action: save() });
  render({ title: "Notes", action: null });
  expect(state.setOptions).toHaveBeenLastCalledWith({ title: "Notes", headerRight: undefined });
  render({ title: "Notes", action: save() });
  expect(button()?.textContent).toBe("Save");

  state.ios26 = true;
  render({ title: "Notes", action: null });
  expect(state.setOptions).toHaveBeenLastCalledWith({
    title: "Notes",
    unstable_headerRightItems: undefined,
  });
});

it("clears its button when the action stops being given", () => {
  render({ title: "Notes", action: save() });
  render({ title: "Notes" });
  expect(state.setOptions.mock.lastCall?.[0]).toStrictEqual({
    title: "Notes",
    headerRight: undefined,
  });
  render({ title: "Notes" });
  expect(state.setOptions).toHaveBeenCalledTimes(2);

  render({ action: save() });
  render({});
  expect(state.setOptions.mock.lastCall?.[0]).toStrictEqual({ headerRight: undefined });
});

it("leaves alone what it was not given", () => {
  render({});
  expect(state.setOptions).not.toHaveBeenCalled();
  render({ title: "Notes" });
  expect(state.setOptions).toHaveBeenLastCalledWith({ title: "Notes" });
  // No title keeps the one already set.
  render({ title: undefined });
  expect(state.setOptions).toHaveBeenCalledTimes(1);
  render({ action: save() });
  expect(Object.keys(state.setOptions.mock.calls.at(-1)?.[0])).toEqual(["headerRight"]);
});

it("sets nothing when the screen leaves", () => {
  render({ title: "Notes", action: save() });
  act(() => root.render(null));
  expect(state.setOptions).toHaveBeenCalledTimes(1);
});
