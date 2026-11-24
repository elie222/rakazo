// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");

  const element =
    (tag: string) =>
    ({ children, style }: { children?: ReactNode; style?: unknown }) =>
      createElement(
        tag,
        { "data-style": JSON.stringify(Object.assign({}, ...[style].flat())) },
        children,
      );

  return {
    Pressable: ({
      children,
      style,
      onPress,
      onLongPress,
      onAccessibilityAction,
      accessibilityRole,
      accessibilityLabel,
      accessibilityState,
    }: {
      children?: ReactNode;
      style?: unknown;
      onPress?: () => void;
      onLongPress?: () => void;
      onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
      accessibilityRole?: string;
      accessibilityLabel?: string;
      accessibilityState?: { checked?: boolean; expanded?: boolean };
    }) =>
      createElement(
        "button",
        {
          "data-style": JSON.stringify(Object.assign({}, ...[style].flat())),
          "data-role": accessibilityRole,
          "aria-label": accessibilityLabel,
          "aria-expanded": accessibilityState?.expanded,
          "data-checked":
            accessibilityState?.checked === undefined
              ? undefined
              : String(accessibilityState.checked),
          onClick: onPress,
          onContextMenu: onLongPress,
          onFocus: () => onAccessibilityAction?.({ nativeEvent: { actionName: "selectMessages" } }),
        },
        children,
      ),
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: element("span"),
    View: element("div"),
  };
});

vi.mock("../../lib/native/native", () => ({
  native: { fill: "fill", fillPressed: "fill-pressed" },
  useMobileTokens: () => ({ foreground: "foreground", mutedForeground: "muted" }),
}));

vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));

import type { VoiceChatGroup } from "@rakazo/core";
import type { MobileMessage } from "../../lib/api/mobile-types";
import { VoiceChatCard } from "./VoiceChatCard";

function styleOf(element: Element | null) {
  return JSON.parse(element?.getAttribute("data-style") ?? "{}") as Record<string, unknown>;
}

describe("VoiceChatCard", () => {
  it("keeps its header 40pt tall and lets it grow with the title at larger text sizes", () => {
    const html = renderToStaticMarkup(
      <VoiceChatCard group={{ kind: "voiceChat", key: "call:1", callId: "1", messages: [] }} />,
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    const header = styleOf(document.querySelector("button"));
    const title = styleOf(document.querySelector("button > span"));

    expect(header.height).toBeUndefined();
    expect(header.minHeight).toBe(40);
    expect(Number(header.paddingVertical) * 2 + Number(title.lineHeight)).toBe(40);
  });

  it("includes each visible duration in the transcript button name when closed and open", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const marker = {
      id: "marker",
      role: "bot",
      blocks: [{ kind: "voice_call", title: "First recap", durationSeconds: 44 }],
    };
    const recorded = {
      kind: "voiceChat",
      key: "call:1",
      callId: "1",
      marker,
      messages: [marker],
    } as unknown as VoiceChatGroup<MobileMessage>;
    const inferred = {
      kind: "voiceChat",
      key: "call:2",
      callId: "2",
      messages: [
        {
          id: "turn-1",
          role: "user",
          createdAt: "2026-01-01T00:00:00Z",
          blocks: [{ kind: "text", text: "A synthetic transcript turn" }],
        },
        {
          id: "turn-2",
          role: "bot",
          createdAt: "2026-01-01T00:02:03Z",
          blocks: [{ kind: "text", text: "Second recap." }],
        },
      ],
    } as unknown as VoiceChatGroup<MobileMessage>;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <>
            <VoiceChatCard group={recorded} />
            <VoiceChatCard group={inferred} />
          </>,
        );
      });
      const [first, second] = [...container.querySelectorAll<HTMLButtonElement>("button")];
      expect(first?.textContent).toBe("Voice chat0:44");
      expect(second?.textContent).toBe("Voice chat2:03");
      expect(first?.getAttribute("aria-label")).toBe("Show transcript: Voice chat, 0:44");
      expect(second?.getAttribute("aria-label")).toBe("Show transcript: Voice chat, 2:03");
      expect(second?.getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).not.toContain("A synthetic transcript turn");

      await act(async () => second?.click());
      expect(first?.getAttribute("aria-expanded")).toBe("false");
      expect(second?.getAttribute("aria-label")).toBe("Hide transcript: Voice chat, 2:03");
      expect(second?.getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("A synthetic transcript turn");

      await act(async () => second?.click());
      expect(second?.getAttribute("aria-label")).toBe("Show transcript: Voice chat, 2:03");
      expect(second?.getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).not.toContain("A synthetic transcript turn");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("opens with its chosen turns and lets each turn be chosen while selecting", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const turn = (id: string, role: "user" | "bot", text: string) =>
      ({
        id,
        role,
        blocks: [{ kind: "text", text }],
      }) as unknown as MobileMessage;
    const hello = turn("m1", "user", "Hello there");
    const answer = turn("m2", "bot", "Hi, how can I help?");
    const group = {
      kind: "voiceChat",
      key: "call:1",
      callId: "1",
      messages: [hello, answer],
    } as unknown as VoiceChatGroup<MobileMessage>;
    const toggled: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <VoiceChatCard
          group={group}
          selectedIds={new Set(["m2"])}
          onToggleSelection={(message) => toggled.push(message.id)}
        />,
      );
    });

    // A card holding a chosen turn mounts open, as it does when the list remounts it.
    const checkboxes = [...container.querySelectorAll<HTMLElement>('[data-role="checkbox"]')];
    expect(checkboxes.map((box) => box.dataset.checked)).toEqual(["false", "true"]);
    await act(async () => {
      checkboxes[0]?.click();
    });
    expect(toggled).toEqual(["m1"]);

    toggled.length = 0;
    await act(async () => {
      container.querySelector<HTMLElement>("button")?.click();
    });
    expect(toggled).toEqual(["m2"]);
    await act(async () => root.unmount());
  });

  it("starts choosing when a transcript turn is long-pressed", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const group = {
      kind: "voiceChat",
      key: "call:1",
      callId: "1",
      messages: [{ id: "m1", role: "user", blocks: [{ kind: "text", text: "Hello there" }] }],
    } as unknown as VoiceChatGroup<MobileMessage>;
    const started: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <VoiceChatCard group={group} onStartSelection={(message) => started.push(message.id)} />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLElement>("button")?.click();
    });
    const turn = container.querySelectorAll<HTMLElement>("button")[1];
    await act(async () => {
      turn?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    expect(started).toEqual(["m1"]);
    // Screen readers cannot long-press: the same turn offers the action instead.
    await act(async () => {
      turn?.focus();
    });
    expect(started).toEqual(["m1", "m1"]);
    await act(async () => root.unmount());
  });

  it("shows plain turns when not selecting", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const group = {
      kind: "voiceChat",
      key: "call:1",
      callId: "1",
      messages: [{ id: "m1", role: "user", blocks: [{ kind: "text", text: "Hello there" }] }],
    } as unknown as VoiceChatGroup<MobileMessage>;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<VoiceChatCard group={group} onToggleSelection={() => undefined} />);
    });
    await act(async () => {
      container.querySelector<HTMLElement>("button")?.click();
    });
    expect(container.querySelector('[data-role="checkbox"]')).toBeNull();
    expect(container.textContent).toContain("Hello there");
    await act(async () => root.unmount());
  });
});
