// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    ActivityIndicator: () => null,
    Alert: { alert: vi.fn() },
    Pressable: ({
      children,
      accessibilityLabel,
      accessibilityState,
      accessibilityActions,
      disabled,
      onPress,
    }: {
      children?: ReactNode;
      accessibilityLabel?: string;
      accessibilityState?: { selected?: boolean };
      accessibilityActions?: Array<{ name: string }>;
      disabled?: boolean;
      onPress?: () => void;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          disabled,
          "data-row": "true",
          "aria-label": accessibilityLabel,
          "aria-pressed": accessibilityState?.selected ? "true" : "false",
          "data-actions": accessibilityActions?.map((action) => action.name).join(","),
          onClick: onPress,
        },
        children,
      ),
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      onFocus,
      onBlur,
      onSubmitEditing,
    }: {
      accessibilityLabel?: string;
      value?: string;
      onChangeText: (value: string) => void;
      onFocus?: () => void;
      onBlur?: () => void;
      onSubmitEditing?: () => void;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        value,
        onFocus,
        onBlur,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
        onKeyDown: (event: { key: string }) => {
          if (event.key === "Enter") onSubmitEditing?.();
        },
      }),
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  };
});
vi.mock("../../lib/appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../../lib/native/native", () => ({ native: {} }));
vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    prominence,
    fill,
    accessibilityActions,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    prominence?: string;
    fill?: boolean;
    accessibilityActions?: Array<{ name: string }>;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        onClick: onPress,
        disabled,
        "data-prominence": prominence,
        "data-fill": fill === undefined ? undefined : String(fill),
        "data-actions": accessibilityActions?.map((action) => action.name).join(","),
      },
      label,
    ),
}));

import { InlineInputFocusContext } from "../../lib/thread/inline-input-focus";
import { AskActions } from "./AskActions";

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

it("lists a question's options as rows and marks the chosen one", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const actions = [
    { id: "research", label: "Research markets" },
    { id: "draft", label: "Draft emails" },
  ];
  await act(async () =>
    root.render(<AskActions actions={actions} approval={false} onAnswer={onAnswer} />),
  );
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>('button[data-row="true"]')];
  expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
    "Research markets",
    "Draft emails",
  ]);
  await act(async () => rows()[1]?.click());
  expect(onAnswer).toHaveBeenCalledWith("draft");

  await act(async () =>
    root.render(
      <AskActions
        actions={actions}
        approval={false}
        disabled
        selectedAnswer="draft"
        onAnswer={onAnswer}
      />,
    ),
  );
  expect(rows().map((row) => row.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
});

it("sends a typed answer from an option card through onTypeAnswer and settles the card", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const onTypeAnswer = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <AskActions
        actions={[
          { id: "choice-1", label: "Plan a trip" },
          { id: "choice-2", label: "Write something" },
        ]}
        approval={false}
        onAnswer={onAnswer}
        onTypeAnswer={onTypeAnswer}
      />,
    ),
  );
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label);

  const typeButton = button("Type your answer")!;
  expect(typeButton.getAttribute("data-prominence")).toBe("quiet");
  expect(typeButton.getAttribute("data-fill")).toBe("false");
  await act(async () => typeButton.click());
  expect(button("Send answer")!.disabled).toBe(true);
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "  A quiet weekend  ",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Send answer")!.click());

  expect(onTypeAnswer).toHaveBeenCalledExactlyOnceWith("A quiet weekend", expect.any(String));
  expect(onAnswer).not.toHaveBeenCalled();
  const rows = [...container.querySelectorAll<HTMLButtonElement>('button[data-row="true"]')];
  expect(rows.map((row) => row.disabled)).toEqual([true, true]);
  expect(rows.map((row) => row.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
  expect(button("Type your answer")).toBeUndefined();
  expect(container.querySelector("input")).toBeNull();
});

it("deduplicates keyboard send plus button tap and reuses the clientNonce on retry while keeping the draft on refusal", async () => {
  const firstRequest = deferred<void>();
  const onTypeAnswer = vi
    .fn<(answer: string, clientNonce: string) => Promise<void>>()
    .mockImplementationOnce(() => firstRequest.promise)
    .mockResolvedValueOnce(undefined);
  await act(async () =>
    root.render(
      <AskActions
        actions={[
          { id: "choice-1", label: "Plan a trip" },
          { id: "choice-2", label: "Write something" },
        ]}
        approval={false}
        onAnswer={async () => undefined}
        onTypeAnswer={onTypeAnswer}
      />,
    ),
  );
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label);

  await act(async () => button("Type your answer")!.click());
  const input = container.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "A quiet weekend",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Keyboard Return and Send button tap in the same tick must dispatch only once.
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    button("Send answer")!.click();
  });
  expect(onTypeAnswer).toHaveBeenCalledTimes(1);
  const firstNonce = onTypeAnswer.mock.calls[0]![1];

  await act(async () => {
    firstRequest.reject({
      code: "QUESTION_ALREADY_ANSWERED",
      message: "This question was already answered",
    });
  });
  expect(Alert.alert).toHaveBeenCalledWith(
    "Could not submit answer",
    "This question was already answered",
  );
  expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("A quiet weekend");

  // Retrying the unchanged draft reuses the exact same clientNonce.
  await act(async () => button("Send answer")!.click());
  expect(onTypeAnswer).toHaveBeenCalledTimes(2);
  expect(onTypeAnswer.mock.calls[1]).toEqual(["A quiet weekend", firstNonce]);
});

it("sends nothing when Return is pressed on an empty typed answer and clears on Cancel", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const onTypeAnswer = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <AskActions
        actions={[
          { id: "choice-1", label: "Plan a trip" },
          { id: "choice-2", label: "Write something" },
        ]}
        approval={false}
        onAnswer={onAnswer}
        onTypeAnswer={onTypeAnswer}
      />,
    ),
  );
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  await act(async () => button("Type your answer")!.click());
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "   ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(onAnswer).not.toHaveBeenCalled();
  expect(onTypeAnswer).not.toHaveBeenCalled();

  await act(async () => button("Cancel")!.click());
  expect(container.querySelector("input")).toBeNull();
  expect(button("Type your answer")).toBeDefined();
});

it("keeps the message's accessibility actions on the typed-answer buttons", async () => {
  await act(async () =>
    root.render(
      <AskActions
        actions={[
          { id: "choice-1", label: "Plan a trip" },
          { id: "choice-2", label: "Write something" },
        ]}
        approval={false}
        onAnswer={async () => undefined}
        onTypeAnswer={async () => undefined}
        accessibilityActions={[{ name: "reply", label: "Reply" }]}
      />,
    ),
  );
  const buttons = () => [...container.querySelectorAll("button")];
  expect(buttons().map((item) => item.getAttribute("data-actions"))).toEqual(
    buttons().map(() => "reply"),
  );
  await act(async () =>
    buttons()
      .find((item) => item.textContent === "Type your answer")!
      .click(),
  );
  expect(buttons().map((item) => item.getAttribute("data-actions"))).toEqual(
    buttons().map(() => "reply"),
  );
});

it("keeps typing off approval, instruction, and answered option cards", async () => {
  await act(async () =>
    root.render(
      <AskActions
        actions={[
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ]}
        approval
        onAnswer={async () => undefined}
        onTypeAnswer={async () => undefined}
      />,
    ),
  );
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain(
    "Type your answer",
  );
  expect(container.querySelector("input")).toBeNull();

  await act(async () =>
    root.render(
      <AskActions
        actions={[
          { id: "allow", label: "Apply" },
          { id: "deny", label: "Dismiss" },
        ]}
        approval
        instructions="Be concise."
        onAnswer={async () => undefined}
        onTypeAnswer={async () => undefined}
      />,
    ),
  );
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain(
    "Type your answer",
  );

  await act(async () =>
    root.render(
      <AskActions
        actions={[
          { id: "choice-1", label: "Plan a trip" },
          { id: "choice-2", label: "Write something" },
        ]}
        approval={false}
        disabled
        selectedAnswer="A quiet weekend"
        onAnswer={async () => undefined}
        onTypeAnswer={async () => undefined}
      />,
    ),
  );
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain(
    "Type your answer",
  );
});

it("hides Type your answer when onTypeAnswer is omitted", async () => {
  await act(async () =>
    root.render(
      <AskActions
        actions={[
          { id: "allow-custom", label: "Confirm action" },
          { id: "deny-custom", label: "Cancel action" },
        ]}
        approval={false}
        onAnswer={async () => undefined}
      />,
    ),
  );
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain(
    "Type your answer",
  );
  expect(container.querySelector("input")).toBeNull();
});

it("reports inline input focus while the typed-answer field is focused and clears it on blur or cancel", async () => {
  const onFocusChange = vi.fn();
  await act(async () =>
    root.render(
      <InlineInputFocusContext.Provider value={onFocusChange}>
        <AskActions
          actions={[
            { id: "choice-1", label: "Plan a trip" },
            { id: "choice-2", label: "Write something" },
          ]}
          approval={false}
          onAnswer={async () => undefined}
          onTypeAnswer={async () => undefined}
        />
      </InlineInputFocusContext.Provider>,
    ),
  );
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label);

  await act(async () => button("Type your answer")!.click());
  expect(onFocusChange).not.toHaveBeenCalled();

  const input = container.querySelector("input")!;
  await act(async () => input.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(onFocusChange).toHaveBeenLastCalledWith(true);

  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(onFocusChange).toHaveBeenLastCalledWith(false);

  await act(async () => input.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(onFocusChange).toHaveBeenLastCalledWith(true);

  await act(async () => button("Cancel")!.click());
  expect(onFocusChange).toHaveBeenLastCalledWith(false);
});
