// @vitest-environment jsdom

import type { AskWaitingOn } from "@rakazo/core";
import type { ReactNode } from "react";
import { act, createContext } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileMessage } from "./mobile-types";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const element =
    (tag: string) =>
    ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
      createElement(tag, { onClick: onPress }, children);
  return {
    Alert: { alert: vi.fn() },
    Appearance: { getColorScheme: () => "light", addChangeListener: () => ({ remove() {} }) },
    Linking: { openURL: vi.fn() },
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
    Pressable: element("button"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: element("span"),
    TextInput: () => createElement("input"),
    View: element("div"),
    useWindowDimensions: () => ({ width: 393, height: 852, scale: 1, fontScale: 1 }),
  };
});

vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  return {
    default: { View },
    useAnimatedStyle: (style: () => unknown) => style(),
    useReducedMotion: () => true,
    useSharedValue: (value: number) => ({ value }),
    withTiming: (value: number) => value,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-secure-store", () => ({}));
vi.mock("./native", () => ({
  native: { fill: "fill" },
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/secret-ask-sheet", () => ({ SecretAskSheet: () => null }));
vi.mock("../components/vault-item-editor", () => ({ VaultItemEditor: () => null }));

import { AskActions } from "../components/AskActions";
import { AskBlock, waitingOnLabel } from "../components/thread/ask-block";

type Ask = Extract<MobileMessage["blocks"][number], { kind: "ask" }>;

const approvalAsk = {
  kind: "ask",
  text: "Review before web_fetch",
  approvalEffectId: "effect-1",
  site: "example.net",
  status: "pending",
  actions: [
    { id: "allow", label: "Allow once" },
    { id: "always", label: "Always allow" },
    { id: "deny", label: "Deny" },
  ],
} as Ask;

const questionAsk = { kind: "ask", text: "Which city?", status: "pending" } as Ask;

describe("waitingOnLabel", () => {
  it("names who the card waits on, or falls back when the name is missing", () => {
    expect(waitingOnLabel({ userId: "casey", name: "Casey" })).toBe("Waiting on Casey");
    expect(waitingOnLabel({ userId: "casey" })).toBe(
      "Only the person who started this can answer it",
    );
  });
});

describe("another member's card in a shared space", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps approval choices in place, disabled, with who it waits on under them", () => {
    const waitingOn: AskWaitingOn = { userId: "casey", name: "Casey" };
    act(() => {
      root.render(
        <>
          <AskActions
            actions={approvalAsk.actions!}
            site={approvalAsk.site}
            approval
            disabled
            onAnswer={async () => {}}
          />
          <span>{waitingOnLabel(waitingOn)}</span>
        </>,
      );
    });
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Allow once",
      "Always allow example.net",
      "Deny",
    ]);
    expect(buttons.every((b) => b.hasAttribute("disabled"))).toBe(true);
    expect(container.textContent).toContain("Waiting on Casey");
  });

  it("lets the run's own user press the choices", async () => {
    const onAnswer = vi.fn(async () => {});
    act(() => {
      root.render(
        <AskActions
          actions={approvalAsk.actions!}
          site={approvalAsk.site}
          approval
          onAnswer={onAnswer}
        />,
      );
    });
    const allow = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Allow once",
    )!;
    expect(allow.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      allow.click();
    });
    expect(onAnswer).toHaveBeenCalledWith("allow");
  });

  it("shows who a text question waits on instead of an answer field", () => {
    act(() => {
      root.render(
        <AskBlock
          ask={questionAsk}
          canAnswer={false}
          canDismiss={false}
          waitingOn={{ userId: "casey", name: "Casey" }}
          onAnswer={async () => {}}
          onDismiss={async () => {}}
          actionProps={{}}
        />,
      );
    });
    expect(container.textContent).toContain("Waiting on Casey");
    expect(container.querySelector("input")).toBeNull();
  });

  it("falls back when the owner's name is not loaded", () => {
    act(() => {
      root.render(
        <AskBlock
          ask={questionAsk}
          canAnswer={false}
          canDismiss={false}
          waitingOn={{ userId: "casey" }}
          onAnswer={async () => {}}
          onDismiss={async () => {}}
          actionProps={{}}
        />,
      );
    });
    expect(container.textContent).toContain("Only the person who started this can answer it");
  });

  it("still reads the bot-waiting line when nobody owns the wait", () => {
    act(() => {
      root.render(
        <AskBlock
          ask={questionAsk}
          canAnswer={false}
          canDismiss={false}
          onAnswer={async () => {}}
          onDismiss={async () => {}}
          actionProps={{}}
        />,
      );
    });
    expect(container.textContent).toContain("Waiting for this bot");
  });
});
