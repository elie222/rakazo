// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    Alert: { alert: vi.fn() },
    TextInput: ({
      accessibilityLabel,
      onChangeText,
      onSubmitEditing,
    }: {
      accessibilityLabel?: string;
      onChangeText: (value: string) => void;
      onSubmitEditing?: () => void;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
        onKeyDown: (event: { key: string }) => {
          if (event.key === "Enter") onSubmitEditing?.();
        },
      }),
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  };
});
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ native: {} }));
vi.mock("./i18n", () => {
  const i18n = { t: (text: string) => text };
  return { useI18n: () => i18n };
});
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, label),
}));

import { AskActions } from "../components/AskActions";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("offers Always allow only when the approval card does", async () => {
  const actions = [
    { id: "allow", label: "Allow once" },
    { id: "always", label: "Always allow this tool" },
    { id: "deny", label: "Deny" },
  ];
  const show = (shown: typeof actions) =>
    act(async () =>
      root.render(<AskActions actions={shown} approval onAnswer={async () => undefined} />),
    );
  const labels = () => [...container.querySelectorAll("button")].map((item) => item.textContent);
  await show(actions);
  expect(labels()).toEqual(["Allow once", "Always allow this tool", "Deny"]);
  await show(actions.filter((action) => action.id !== "always"));
  expect(labels()).toEqual(["Allow once", "Deny"]);
});

it("sends a typed answer from an option card through the same answer path", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const show = () =>
    act(async () =>
      root.render(
        <AskActions
          actions={[
            { id: "choice-1", label: "Plan a trip" },
            { id: "choice-2", label: "Write something" },
          ]}
          approval={false}
          onAnswer={onAnswer}
        />,
      ),
    );
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
  await show();

  await act(async () => button("Type your answer").click());
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "A quiet weekend",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Send answer").click());

  expect(onAnswer).toHaveBeenCalledWith("A quiet weekend");
});

it("sends nothing when Return is pressed on an empty typed answer", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <AskActions
        actions={[
          { id: "choice-1", label: "Plan a trip" },
          { id: "choice-2", label: "Write something" },
        ]}
        approval={false}
        onAnswer={onAnswer}
      />,
    ),
  );
  const typeButton = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Type your answer",
  )!;
  await act(async () => typeButton.click());
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "   ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

  expect(onAnswer).not.toHaveBeenCalled();
});

it("keeps typing off approval cards", async () => {
  await act(async () =>
    root.render(
      <AskActions
        actions={[
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ]}
        approval
        onAnswer={async () => undefined}
      />,
    ),
  );
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain(
    "Type your answer",
  );
  expect(container.querySelector("input")).toBeNull();
});
