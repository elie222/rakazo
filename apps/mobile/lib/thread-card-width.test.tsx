// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { ComponentProps, ReactNode, Ref } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Linking } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileMessage } from "./api";

vi.mock("react-native", async () => {
  const { createElement, useImperativeHandle } = await import("react");
  const flatten = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flatten))
      : ((style as Record<string, unknown>) ?? {});
  const element =
    (tag: string) =>
    ({
      children,
      style,
      onPress,
      onLongPress,
      numberOfLines,
      accessibilityState,
      accessibilityRole,
      accessibilityLabel,
      ref,
    }: {
      children?: ReactNode;
      style?: unknown;
      onPress?: () => void;
      onLongPress?: () => void;
      numberOfLines?: number;
      accessibilityState?: { expanded?: boolean };
      accessibilityRole?: string;
      accessibilityLabel?: string;
      ref?: Ref<unknown>;
    }) => {
      useImperativeHandle(ref, () => ({
        measureInWindow: (done: (...values: number[]) => void) => done(0, 100, 300, 200),
      }));
      return createElement(
        tag,
        {
          "data-style": JSON.stringify(flatten(style)),
          "data-number-of-lines": numberOfLines,
          "aria-expanded": accessibilityState?.expanded,
          role: accessibilityRole,
          "aria-label": accessibilityLabel,
          onClick: onPress,
          onContextMenu: onLongPress,
        },
        children,
      );
    };
  return {
    Alert: { alert: vi.fn() },
    Appearance: { getColorScheme: () => "light", addChangeListener: () => ({ remove() {} }) },
    Linking: { openURL: vi.fn().mockResolvedValue(undefined) },
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
    Pressable: element("button"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: element("span"),
    TextInput: element("input"),
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

vi.mock("expo-secure-store", () => ({}));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./artifact-open", () => ({ openMobileArtifact: vi.fn() }));

vi.mock("./native", () => ({
  native: { fill: "fill", fillPressed: "fill-pressed" },
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));

vi.mock("@rakazo/chat-ui/native", () => ({
  ChatMarkdown: ({ children }: { children: string }) => <p>{children}</p>,
  withBlockMentions: <T,>(blocks: T) => blocks,
}));

vi.mock("../components/message-caption", () => ({
  MessageCaption: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => <i /> }));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios }: { ios: string }) => <i data-symbol={ios} />,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
// Cards this file doesn't exercise; each has its own tests.
vi.mock("../components/thread/ask-block", () => ({ AskBlock: () => null }));
vi.mock("../components/AppConnectCard", () => ({ AppConnectCard: () => null }));
vi.mock("../components/audio-attachment", () => ({ AudioAttachment: () => null }));
vi.mock("../components/ChoiceCard", () => ({ ChoiceCard: () => null }));
vi.mock("../components/ComputerCard", () => ({ ComputerCard: () => null }));
vi.mock("../components/inline-image-attachment", () => ({
  InlineImageAttachment: ({ name, onOpen }: { name: string; onOpen: () => void }) => (
    <button type="button" aria-label={name} onClick={onOpen} />
  ),
}));
vi.mock("../components/change-undo", () => ({
  ChangeUndo: () => null,
  isUndoableChange: () => false,
}));

import { McpApprovalCard } from "../components/McpApprovalCard";
import { MessageBubble } from "../components/thread/message-bubble";

type BubbleProps = ComponentProps<typeof MessageBubble>;

function Bubble(props: Partial<BubbleProps> & Pick<BubbleProps, "message">) {
  return (
    <MessageBubble
      botId="bot-1"
      bots={[]}
      showBotSenderName={false}
      canAnswer={false}
      canDismiss={false}
      onAnswer={async () => undefined}
      onOpenBot={() => undefined}
      onOpenComputer={() => undefined}
      onPreviewMarkdown={() => undefined}
      onPreviewImage={() => undefined}
      onOpenPeerChat={() => undefined}
      actionProps={{}}
      {...props}
    />
  );
}

const longQuestion =
  "Should I move the weekly planning notes into the shared folder and tell everyone on the project where to find them from now on?";

type CardStyle = { width?: unknown; maxWidth?: unknown };

function styleOf(element: Element | null | undefined): CardStyle {
  if (!element) throw new Error("missing card");
  return JSON.parse(element.getAttribute("data-style") ?? "{}");
}

describe("thread cards", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  const helper = (agentId = "agent-1"): MessageBlock => ({
    kind: "subagent",
    agentId,
    name: agentId,
    status: "completed",
    task: "Check the plan",
  });
  const child: MessageBlock = {
    kind: "child_bot",
    botId: "child-1",
    name: "Planner",
    status: "created",
  };
  const cloud: MessageBlock = {
    kind: "cloud_agent",
    agentId: "cloud-1",
    url: "https://example.test/task",
    title: "Remote task",
    status: "finished",
  };
  const text = (value: string): MessageBlock => ({ kind: "text", text: value });

  function renderBlocks(blocks: MessageBlock[], overrides = {}, role: "bot" | "user" = "bot") {
    act(() =>
      root.render(
        <Bubble
          botId="bot-1"
          bots={[]}
          message={{ id: "message-1", role, blocks }}
          canAnswer={false}
          actionProps={{}}
          {...overrides}
        />,
      ),
    );
  }

  it.each(["user", "bot"] as const)(
    "keeps %s image attachments outside the caption and file bubbles",
    (role) => {
      const onPreviewImage = vi.fn();
      renderBlocks(
        [
          text("Pictures"),
          { kind: "image", artifactId: "image-1", name: "photo.png", mimeType: "image/png" },
          { kind: "image", artifactId: "image-2", name: "screenshot.png", mimeType: "image/png" },
          {
            kind: "file",
            artifactId: "file-1",
            name: "notes.txt",
            mimeType: "text/plain",
            size: 10,
          },
        ],
        { onPreviewImage },
        role,
      );
      const outer = container.firstElementChild!;
      for (const name of ["photo.png", "screenshot.png"]) {
        const image = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
        for (const frame of [image.parentElement, outer]) {
          const style = styleOf(frame);
          expect(style).not.toHaveProperty("backgroundColor");
          expect(style).not.toHaveProperty("borderWidth");
          expect(style).not.toHaveProperty("paddingHorizontal");
          expect(style).not.toHaveProperty("paddingVertical");
        }
      }
      expect(styleOf(outer.firstElementChild)).toMatchObject({
        borderRadius: 20,
        paddingHorizontal: 14,
        paddingVertical: 12,
      });
      expect(styleOf(outer.lastElementChild)).toMatchObject({
        borderRadius: 20,
        paddingHorizontal: 14,
        paddingVertical: 12,
      });
      act(() =>
        container.querySelector<HTMLButtonElement>('button[aria-label="screenshot.png"]')!.click(),
      );
      expect(onPreviewImage).toHaveBeenCalledWith({
        artifactId: "image-2",
        name: "screenshot.png",
        mimeType: "image/png",
      });
    },
  );

  it.each([
    [
      "helper then text",
      [helper(), text("Ship Flow B")],
      ["agent-1CompletedCheck the plan", "Ship Flow B"],
    ],
    ["text around a child", [text("Before"), child, text("After")], ["Before", "Planner", "After"]],
    ["cloud then text", [cloud, text("Cloud result")], ["Remote taskfinished", "Cloud result"]],
    [
      "two helpers",
      [helper(), helper("agent-2")],
      ["agent-1CompletedCheck the plan", "agent-2CompletedCheck the plan"],
    ],
  ])("renders %s in block order", (_, blocks, expected) => {
    renderBlocks(blocks as MessageBlock[]);
    expect([...container.firstElementChild!.children].map((piece) => piece.textContent)).toEqual(
      expected,
    );
    expect(styleOf(container.firstElementChild)).toMatchObject({ gap: 8, width: "100%" });
  });

  it.each([helper(), cloud])("preserves a lone $kind card's width and padding", (block) => {
    renderBlocks([block]);
    expect(container.children).toHaveLength(1);
    expect(styleOf(container.firstElementChild)).toMatchObject({
      width: "90%",
      borderRadius: 18,
    });
    if (block.kind === "subagent") {
      expect(styleOf(container.querySelector("button[aria-expanded]"))).toMatchObject({
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 14,
        minHeight: 44,
      });
      expect(container.querySelector("[data-symbol='chevron.down']")).not.toBeNull();
      expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
        "false",
      );
    } else {
      expect(styleOf(container.firstElementChild)).toMatchObject({
        paddingHorizontal: 16,
        paddingVertical: 14,
      });
    }
  });

  it.each([
    ["no longer in the roster", child, []],
    ["deleted", { ...child, status: "deleted" }, [{ id: "child-1", name: "Planner" }]],
  ])("keeps a child bot's name without a link when it is %s", (_, block, bots) => {
    const onOpenBot = vi.fn();
    renderBlocks([block as MessageBlock], { bots, onOpenBot });
    const row = container.firstElementChild as HTMLElement;
    expect(row.textContent).toContain("Planner");
    expect(row.querySelector('[role="link"]')).toBeNull();
    act(() => {
      for (const span of row.querySelectorAll("span")) span.click();
    });
    expect(onOpenBot).not.toHaveBeenCalled();
  });

  it("keeps child navigation and long-press actions on each card and text piece", () => {
    const onOpenBot = vi.fn();
    const onLongPress = vi.fn();
    renderBlocks([helper(), child, text("After")], {
      bots: [{ id: "child-1", name: "Planner", color: "orange" }],
      onOpenBot,
      actionProps: { onLongPress },
    });
    const cards = [...container.firstElementChild!.children] as HTMLElement[];
    expect(cards).toHaveLength(3);
    act(() => cards[1]!.querySelector<HTMLElement>('[role="link"]')!.click());
    expect(onOpenBot).toHaveBeenCalledWith("child-1", "Planner");
    act(() =>
      cards.forEach((card) => {
        const target = card.tagName === "DIV" ? card.querySelector("button")! : card;
        target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      }),
    );
    expect(onLongPress).toHaveBeenCalledTimes(3);
  });

  it("keeps contiguous text in the normal bubble and leaves text-only messages unchanged", () => {
    renderBlocks([helper(), text("First"), text("Second")]);
    expect([...container.firstElementChild!.children].map((piece) => piece.textContent)).toEqual([
      "agent-1CompletedCheck the plan",
      "First\nSecond",
    ]);
    renderBlocks([text("First"), text("Second")]);
    expect(container.children).toHaveLength(1);
    expect(container.textContent).toBe("First\nSecond");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("keeps cloud links accessible alongside text", () => {
    const onLongPress = vi.fn();
    renderBlocks([cloud, text("After")], { actionProps: { onLongPress } });
    const link = container.querySelector('[role="link"]');
    expect(link?.getAttribute("aria-label")).toBe("Remote task: finished");
    act(() => (link as HTMLElement).click());
    expect(Linking.openURL).toHaveBeenCalledWith("https://example.test/task");
    act(() => link!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("opens helpers independently and keeps each header in view through the toggle callback", () => {
    const onLongPress = vi.fn();
    const measurements: number[][] = [];
    const onHelperToggle = vi.fn((measure, toggle, opening) => {
      measure((...values: number[]) => measurements.push(values));
      toggle();
      expect(typeof opening).toBe("boolean");
    });
    const blocks = [
      { ...helper("first"), result: "First report" },
      text("Between"),
      { ...helper("second"), result: "Second report" },
    ] as MessageBlock[];
    renderBlocks(blocks, { onHelperToggle, actionProps: { onLongPress } });
    const headers = () => [...container.querySelectorAll<HTMLElement>("button[aria-expanded]")];
    expect(headers()).toHaveLength(2);
    expect(container.querySelectorAll("[data-symbol='chevron.down']")).toHaveLength(2);
    act(() => headers()[0]!.click());
    expect(headers().map((header) => header.getAttribute("aria-expanded"))).toEqual([
      "true",
      "false",
    ]);
    expect(container.textContent).toContain("First report");
    expect(container.textContent).not.toContain("Second report");
    expect(onHelperToggle.mock.calls[0]![2]).toBe(true);
    expect(measurements).toEqual([[100, 300]]);
    act(() => headers()[1]!.click());
    expect(container.textContent).toContain("Second report");
    act(() => headers()[0]!.click());
    expect(headers().map((header) => header.getAttribute("aria-expanded"))).toEqual([
      "false",
      "true",
    ]);
    expect(onHelperToggle.mock.calls[2]![2]).toBe(false);
    act(() => container.querySelector("p")!.click());
    expect(headers()[1]!.getAttribute("aria-expanded")).toBe("true");
    act(() =>
      container.querySelector("p")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    expect(onLongPress).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    root = createRoot(container);
    renderBlocks(blocks);
    expect(headers().map((header) => header.getAttribute("aria-expanded"))).toEqual([
      "false",
      "true",
    ]);
  });

  function renderAsk(ask: Partial<Extract<MessageBlock, { kind: "ask" }>>, canAnswer: boolean) {
    const message = {
      id: "message-1",
      role: "bot",
      blocks: [
        {
          kind: "ask",
          text: longQuestion,
          status: "pending",
          actions: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          ...ask,
        },
      ],
    } as MobileMessage;
    act(() =>
      root.render(
        <Bubble
          botId="bot-1"
          bots={[]}
          message={message}
          canAnswer={canAnswer}
          onAnswer={async () => undefined}
          actionProps={{}}
        />,
      ),
    );
    const question = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === longQuestion,
    );
    return question?.parentElement;
  }

  it.each([false, true])(
    "keeps text passive when surface gestures are enabled: %s",
    (doubleTapSurface) => {
      act(() =>
        root.render(
          <Bubble
            botId="bot-1"
            bots={[]}
            message={{ id: "text-1", role: "bot", blocks: [{ kind: "text", text: "Hello" }] }}
            canAnswer={false}
            onAnswer={async () => undefined}
            actionProps={{}}
            doubleTapSurface={doubleTapSurface}
          />,
        ),
      );
      expect(container.textContent).toBe("Hello");
      expect(container.querySelectorAll("button").length).toBe(doubleTapSurface ? 0 : 1);
    },
  );

  // The iOS message menu hosts each bubble without a definite width, so a percentage width
  // resolves against the card's own cap instead of the message column and overflows the screen.
  it.each([
    ["expired", {}, false],
    ["answered", { status: "answered" as const, answer: "yes" }, false],
    ["active", {}, true],
    [
      "approval",
      {
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      },
      true,
    ],
  ])("bounds a long %s question card by its cap, not a percentage width", (_, ask, canAnswer) => {
    const card = renderAsk(ask, canAnswer);
    expect(card?.textContent).toContain(longQuestion);
    expect(styleOf(card)).toMatchObject({ maxWidth: 576 });
    expect(styleOf(card).width).toBeUndefined();
  });

  it.each([
    ["an unmarked", undefined, undefined, 15],
    ["a text", "text" as const, undefined, 15],
    ["a code", "code" as const, "Menlo", 14],
    ["an unmarked approval", undefined, "Menlo", 14, "effect-1"],
    ["a text approval", "text" as const, undefined, 15, "effect-1"],
  ])(
    "sets %s question detail in its font",
    (_, detailFormat, fontFamily, fontSize, effectId?: string) => {
      const detail = "Tap one option, or reply in your own words.";
      renderAsk({ detail, detailFormat, approvalEffectId: effectId }, true);
      const line = [...container.querySelectorAll("span")].find(
        (span) => span.textContent === detail,
      );
      const style: { fontFamily?: string; fontSize?: number } = JSON.parse(
        line?.getAttribute("data-style") ?? "{}",
      );
      expect(style.fontFamily).toBe(fontFamily);
      expect(style.fontSize).toBe(fontSize);
    },
  );

  it("bounds the MCP approval card the same way", () => {
    act(() =>
      root.render(
        <McpApprovalCard
          botId="bot-1"
          block={{
            kind: "mcp_approval",
            serverId: "server-1",
            name: "Example notes",
            transport: "streamable_http",
            endpoint: "https://mcp.example.test/a/very/long/endpoint/path/for/the/notes/server",
            needsOAuth: false,
            status: "pending",
          }}
        />,
      ),
    );
    const card = container.firstElementChild;
    expect(card?.textContent).toContain("Example notes");
    expect(styleOf(card)).toMatchObject({ maxWidth: 576 });
    expect(styleOf(card).width).toBeUndefined();
  });

  it("labels a running helper", () => {
    const message = {
      id: "running-message",
      role: "bot",
      blocks: [
        {
          kind: "subagent",
          agentId: "running-helper",
          name: "writer",
          task: longQuestion,
          status: "running",
        },
      ],
    } as MobileMessage;
    act(() => root.render(<Bubble botId="bot-1" bots={[]} message={message} actionProps={{}} />));
    expect(container.textContent).toContain("Running");
  });

  it("folds a helper card to one line of the task until it is pressed, across its saved message", () => {
    const message = {
      id: "message-1",
      role: "bot",
      blocks: [
        {
          kind: "subagent",
          agentId: "agent-1",
          name: "writer",
          task: longQuestion,
          status: "completed",
          result: "A long report",
        },
      ],
    } as MobileMessage;
    const onLongPress = vi.fn();
    act(() =>
      root.render(
        <Bubble botId="bot-1" bots={[]} message={message} actionProps={{ onLongPress }} />,
      ),
    );
    const card = () => container.querySelector("button[aria-expanded]");
    expect(container.querySelector("[data-symbol='chevron.down']")).not.toBeNull();
    expect(container.textContent).toContain("Completed");
    act(() => card()?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    expect(onLongPress).toHaveBeenCalled();
    const task = () =>
      [...container.querySelectorAll("span")].find((span) => span.textContent === longQuestion);
    expect(card()?.getAttribute("aria-expanded")).toBe("false");
    expect(task()?.getAttribute("data-number-of-lines")).toBe("1");
    expect(container.textContent).not.toContain("A long report");

    act(() => (card() as HTMLElement).click());
    expect(card()?.getAttribute("aria-expanded")).toBe("true");
    expect(task()?.hasAttribute("data-number-of-lines")).toBe(false);
    expect(container.textContent).toContain("A long report");

    onLongPress.mockClear();
    act(() =>
      container.querySelector("p")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    expect(onLongPress).toHaveBeenCalledTimes(1);
    act(() => container.querySelector("p")?.click());
    expect(card()?.getAttribute("aria-expanded")).toBe("true");

    // The saved message replaces the live card under a new id; the card stays open.
    const saved = { ...message, id: "message-2" };
    act(() =>
      root.render(<Bubble key="saved" botId="bot-1" bots={[]} message={saved} actionProps={{}} />),
    );
    expect(card()?.getAttribute("aria-expanded")).toBe("true");

    act(() => (card() as HTMLElement).click());
    expect(card()?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("A long report");
  });
});
