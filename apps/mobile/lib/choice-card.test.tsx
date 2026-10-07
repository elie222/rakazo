// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());

vi.mock("react-native", async () => {
  const { createElement } = await import("react");

  function MockView(props: { children?: ReactNode; testID?: string }) {
    return createElement("div", { "data-testid": props.testID }, props.children);
  }

  function MockText(props: { children?: ReactNode; accessibilityRole?: string }) {
    return createElement("span", { role: props.accessibilityRole }, props.children);
  }

  function MockPressable(props: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityState?: { disabled?: boolean; selected?: boolean };
    testID?: string;
  }) {
    const disabled = Boolean(props.disabled || props.accessibilityState?.disabled);
    return createElement(
      "button",
      {
        type: "button",
        disabled,
        "aria-label": props.accessibilityLabel,
        "aria-selected": props.accessibilityState?.selected ? "true" : "false",
        "data-testid": props.testID,
        onClick: () => {
          if (!disabled) props.onPress?.();
        },
      },
      props.children,
    );
  }

  return {
    Alert: { alert },
    Pressable: MockPressable,
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: MockText,
    View: MockView,
    useWindowDimensions: () => ({ width: 393, height: 852, scale: 1, fontScale: 1 }),
  };
});

vi.mock("./api", () => ({ rpc }));

vi.mock("./native", () => ({
  native: { fill: "fill", fillPressed: "fill-pressed" },
  useMobileTokens: () => ({
    background: "background",
    border: "border",
    card: "card",
    foreground: "foreground",
    mutedForeground: "muted",
  }),
}));

vi.mock("../components/native-symbol", () => ({
  NativeSymbol: () => null,
}));

import { ChoiceCard } from "../components/ChoiceCard";

type ChoiceBlock = Extract<MessageBlock, { kind: "choice" }>;

const choice: ChoiceBlock = {
  kind: "choice",
  question: "What do you want me on first?",
  options: [
    { id: "day", letter: "A", label: "Day-to-day work" },
    { id: "inbox", letter: "B", label: "Inbox & email" },
  ],
};

function button(container: HTMLElement, label: string) {
  const element = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`missing button ${label}`);
  return element;
}

describe("ChoiceCard", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    rpc.mockReset();
    alert.mockReset();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = undefined;
    container = undefined;
  });

  function render(block: ChoiceBlock = choice, onDismissed?: () => void) {
    if (!container) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    act(() => {
      root?.render(<ChoiceCard botId="bot-1" block={block} onDismissed={onDismissed} />);
    });
    return container;
  }

  it("chooses through onboarding/choose and keeps only that option", async () => {
    rpc.mockResolvedValue({});
    const view = render();

    await act(async () => {
      button(view, "Inbox & email").click();
      await Promise.resolve();
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("onboarding/choose", { botId: "bot-1", optionId: "inbox" });
    expect(view.textContent).toContain("Inbox & email");
    expect(view.textContent).not.toContain("Day-to-day work");
    expect(button(view, "Inbox & email").disabled).toBe(true);
    expect(button(view, "Inbox & email").getAttribute("aria-selected")).toBe("true");
    expect(view.querySelector("[data-testid='choice-card-dismiss']")).toBeNull();
  });

  it("dismisses through onboarding/dismissFocus and hides the card", async () => {
    rpc.mockResolvedValue({});
    const onDismissed = vi.fn();
    const view = render(choice, onDismissed);

    await act(async () => {
      button(view, "Dismiss").click();
      await Promise.resolve();
    });

    expect(rpc).toHaveBeenCalledWith("onboarding/dismissFocus", { botId: "bot-1" });
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(view.querySelector("[data-testid='choice-card']")).toBeNull();
  });

  it("disables every control while a request is in flight", async () => {
    let release: (value: unknown) => void = () => undefined;
    rpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = render();

    await act(async () => {
      button(view, "Day-to-day work").click();
      button(view, "Inbox & email").click();
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("onboarding/choose", {
      botId: "bot-1",
      optionId: "day",
    });
    expect(button(view, "Day-to-day work").disabled).toBe(true);
    expect(button(view, "Inbox & email").disabled).toBe(true);
    expect(button(view, "Dismiss").disabled).toBe(true);
    expect(view.textContent).toContain("Inbox & email");

    button(view, "Inbox & email").click();
    expect(rpc).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({});
      await Promise.resolve();
    });

    expect(view.textContent).toContain("Day-to-day work");
    expect(view.textContent).not.toContain("Inbox & email");
  });

  it("reports a failed request and leaves the card unanswered", async () => {
    rpc.mockRejectedValueOnce(new Error("Network down"));
    const view = render();

    await act(async () => {
      button(view, "Inbox & email").click();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith("Could not complete action", "Network down");
    expect(button(view, "Day-to-day work").disabled).toBe(false);
    expect(button(view, "Inbox & email").disabled).toBe(false);
    expect(view.querySelector("[data-testid='choice-card-dismiss']")).not.toBeNull();

    rpc.mockResolvedValueOnce({});
    await act(async () => {
      button(view, "Inbox & email").click();
      await Promise.resolve();
    });

    expect(rpc).toHaveBeenLastCalledWith("onboarding/choose", {
      botId: "bot-1",
      optionId: "inbox",
    });
    expect(view.textContent).not.toContain("Day-to-day work");
  });

  it("lets a later server answer replace the option chosen locally", async () => {
    rpc.mockResolvedValue({});
    const view = render();

    await act(async () => {
      button(view, "Day-to-day work").click();
      await Promise.resolve();
    });
    expect(view.textContent).not.toContain("Inbox & email");

    render({ ...choice, answerId: "inbox" });

    expect(view.textContent).toContain("Inbox & email");
    expect(view.textContent).not.toContain("Day-to-day work");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
