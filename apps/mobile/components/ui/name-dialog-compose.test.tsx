// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ComposeNameDialog from "./name-dialog-compose";

const capture = vi.hoisted(() => ({
  field: vi.fn(),
  buttons: vi.fn(),
  host: vi.fn(),
  announce: vi.fn(),
}));
vi.mock("../../lib/native/native", () => ({ useResolvedAppearance: () => "dark" }));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: capture.announce },
}));
vi.mock("@expo/ui/jetpack-compose", () => {
  const slot = ({ children }: { children: ReactNode }) => children;
  return {
    useNativeState: (value: unknown) => ({ value }),
    Host: (props: { children: ReactNode }) => {
      capture.host(props);
      return props.children;
    },
    AlertDialog: Object.assign(slot, {
      Title: slot,
      Text: slot,
      ConfirmButton: slot,
      DismissButton: slot,
    }),
    OutlinedTextField: Object.assign(
      (props: { children: ReactNode }) => {
        capture.field(props);
        return props.children;
      },
      { Label: slot, SupportingText: slot },
    ),
    Text: slot,
    TextButton: (props: { children: ReactNode }) => {
      capture.buttons(props);
      return props.children;
    },
  };
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function dialog(error: string | null) {
  return (
    <ComposeNameDialog
      draft="Draft"
      error={error}
      saving={false}
      onSave={vi.fn()}
      onChange={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

it("announces a save error once when it appears, not again on re-render", async () => {
  await act(async () => root.render(dialog(null)));
  expect(capture.announce).not.toHaveBeenCalled();
  await act(async () => root.render(dialog("Could not update name")));
  expect(capture.announce).toHaveBeenCalledOnce();
  expect(capture.announce).toHaveBeenLastCalledWith("Could not update name");
  await act(async () => root.render(dialog("Could not update name")));
  expect(capture.announce).toHaveBeenCalledOnce();
});
it("announces a retry that fails with the same message again", async () => {
  // A new save clears the error first, so the same message reappears as a change.
  await act(async () => root.render(dialog("Could not update name")));
  await act(async () => root.render(dialog(null)));
  await act(async () => root.render(dialog("Could not update name")));
  expect(capture.announce).toHaveBeenCalledTimes(2);
  expect(capture.announce).toHaveBeenLastCalledWith("Could not update name");
});
it("announces nothing without an error", async () => {
  await act(async () => root.render(dialog(null)));
  expect(capture.announce).not.toHaveBeenCalled();
});

it("prefills and focuses a single-line limited field, and saves the IME value", () => {
  const onSave = vi.fn();
  const onChange = vi.fn();
  const markup = renderToStaticMarkup(
    <ComposeNameDialog
      draft="Draft"
      error="Try again"
      saving={false}
      onSave={onSave}
      onChange={onChange}
      onClose={vi.fn()}
    />,
  );
  expect(markup).toContain("Try again");
  const field = capture.field.mock.lastCall![0];
  expect(field).toMatchObject({
    value: { value: "Draft" },
    selection: { value: { start: 0, end: 5 } },
    autoFocus: true,
    singleLine: true,
    maxLength: 80,
    isError: true,
    keyboardOptions: { imeAction: "done" },
  });
  field.keyboardActions.onDone("Latest draft");
  expect(onSave).toHaveBeenCalledWith("Latest draft");
  field.onValueChange("Edited");
  expect(onChange).toHaveBeenCalledWith("Edited");
  expect(capture.host.mock.lastCall![0].colorScheme).toBe("dark");
});
it.each([
  ["", false],
  ["   ", false],
  ["Draft", true],
] as const)("disables saving for draft %j and saving %s", (draft, saving) => {
  const onSave = vi.fn();
  renderToStaticMarkup(
    <ComposeNameDialog
      draft={draft}
      saving={saving}
      error={null}
      onSave={onSave}
      onChange={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(capture.buttons.mock.calls[0]![0].enabled).toBe(false);
  capture.field.mock.lastCall![0].keyboardActions.onDone(draft);
  expect(onSave).not.toHaveBeenCalled();
});
it("uses Save and Cancel text buttons", async () => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  renderToStaticMarkup(
    <ComposeNameDialog
      draft="Draft"
      saving={false}
      error={null}
      onSave={onSave}
      onChange={vi.fn()}
      onClose={onClose}
    />,
  );
  // Compose buttons only draw Compose children, so a bare string label renders nothing.
  const { Text } = await import("@expo/ui/jetpack-compose");
  const labels = capture.buttons.mock.calls.map(([props]) => props.children);
  expect(labels.map((label) => label.type)).toEqual([Text, Text]);
  expect(labels.map((label) => label.props.children)).toEqual(["Save", "Cancel"]);
  // Buttons and the focused field follow the app's own foreground, not a generated palette.
  const colors = capture.buttons.mock.calls.map(([props]) => props.colors?.contentColor);
  expect(colors).toEqual(["#FFFFFF", "#FFFFFF"]);
  expect(capture.field.mock.lastCall![0].colors).toMatchObject({
    focusedIndicatorColor: "#FFFFFF",
    focusedLabelColor: "#FFFFFF",
    cursorColor: "#FFFFFF",
  });
  expect(capture.field.mock.lastCall![0].textSelectionColors).toEqual({
    handleColor: "#FFFFFF",
    backgroundColor: "#FFFFFF33",
  });
  capture.field.mock.lastCall![0].value.value = "Latest draft";
  capture.buttons.mock.calls[0]![0].onClick();
  capture.buttons.mock.calls[1]![0].onClick();
  expect(onSave).toHaveBeenCalledWith("Latest draft");
  expect(onClose).toHaveBeenCalledOnce();
});
