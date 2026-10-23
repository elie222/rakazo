// @vitest-environment jsdom

import { buildComposerMentionOptions } from "@rakazo/core";
import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import type { ComponentProps, ReactNode, Ref } from "react";
import { act, createElement, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadComposerHandle } from "../components/thread-composer";
import { ThreadComposer } from "../components/thread-composer";
import { settleComposer } from "./thread-feedback";
import { useThreadMentionCatalog } from "./thread-mention-catalog";

const dimensions = vi.hoisted(() => ({ fontScale: 1 }));

const input = vi.hoisted(() => ({
  change: (_value: string) => {},
  key: (_event: { nativeEvent: { key: string } }) => {},
}));
const mentionApi = vi.hoisted(() => ({ rpc: vi.fn(), capture: vi.fn(), generation: 1 }));
vi.mock("./api", () => ({
  rpc: mentionApi.rpc,
  captureApiRequestContext: mentionApi.capture,
  currentApiBase: () => "https://api.test",
  selectedSpaceId: () => "space-a",
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => mentionApi.generation,
  subscribeSessionGeneration: () => () => {},
}));
vi.mock("react-native", () => {
  const Surface = ({
    children,
    testID,
    style,
  }: {
    children?: ReactNode;
    testID?: string;
    style?: object;
  }) =>
    createElement("div", { "data-testid": testID, "data-style": JSON.stringify(style) }, children);
  return {
    useWindowDimensions: () => dimensions,
    View: Surface,
    ScrollView: Surface,
    Text: Surface,
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessible,
      disabled,
      style,
    }: {
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
      accessible?: boolean;
      disabled?: boolean;
      style?: object;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          "aria-label": accessibilityLabel,
          "data-accessible": accessible,
          disabled,
          "data-style": JSON.stringify(style),
        },
        children,
      ),
    TextInput: ({
      ref,
      value,
      onChangeText,
      onKeyPress,
      style,
      scrollEnabled,
    }: {
      ref?: Ref<HTMLInputElement>;
      value: string;
      onChangeText: typeof input.change;
      onKeyPress: typeof input.key;
      style: object;
      scrollEnabled?: boolean;
    }) => {
      input.change = onChangeText;
      input.key = onKeyPress;
      return createElement("input", {
        ref,
        value,
        readOnly: true,
        "data-style": JSON.stringify(style),
        "data-scroll-enabled": scrollEnabled,
      });
    },
  };
});
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../components/glass-surface", () => ({
  GlassSurface: ({
    children,
    shape = "capsule",
    style,
  }: {
    children?: ReactNode;
    shape?: string;
    style?: object;
  }) =>
    createElement("div", { "data-glass": shape, "data-style": JSON.stringify(style) }, children),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}), useResolvedAppearance: () => "light" }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

const skill = {
  id: "skill-1",
  name: "Writing",
  description: "Write",
  source: "user",
  readOnly: false,
} as const;
const bot = { kind: "bot", id: "bot-2", name: "Helper" } as const;
const props: Omit<ComponentProps<typeof ThreadComposer>, "ref"> = {
  agentSkills: [skill],
  composerMentionTargets: [bot],
  composerPrompt: "Message…",
  replyQuote: null,
  attachmentIds: [],
  botId: "bot-1",
  onCall: false,
  working: false,
  sending: false,
  styles: { circleButton: {}, composerFill: {} },
  attachActions: [],
  attachFrom: vi.fn(),
  send: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  startVoiceCall: vi.fn(async () => {}),
  onSlashAction: vi.fn(),
};

describe("thread composer isolation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let threadRenders: number;
  const composer = createRef<ThreadComposerHandle>();
  function ThreadHarness({
    threadKey = "bot-1",
    ...changes
  }: Partial<typeof props> & { threadKey?: string }) {
    threadRenders += 1;
    return <ThreadComposer key={threadKey} ref={composer} {...props} {...changes} />;
  }
  const catalogBots = [{ id: "bot-1", name: "Bot" }];
  function MentionThreadHarness({ owner = "thread-a" }: { owner?: string }) {
    const catalog = useThreadMentionCatalog(owner, catalogBots);
    return (
      <ThreadComposer
        key={owner}
        ref={composer}
        {...props}
        onMentionRequested={catalog.onMentionRequested}
        composerMentionTargets={buildComposerMentionOptions({
          query: "",
          bots: [],
          groups: [],
          routines: catalog.routines,
          connectors: catalog.connectors,
        })}
      />
    );
  }
  function render(changes: Partial<typeof props> & { threadKey?: string } = {}) {
    act(() => root.render(<ThreadHarness {...changes} />));
  }
  function type(value: string) {
    act(() => input.change(value));
  }
  function press(label: string) {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    expect(button).not.toBeNull();
    act(() => button.click());
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    dimensions.fontScale = 1;
    threadRenders = 0;
    mentionApi.generation = 1;
    mentionApi.rpc.mockReset().mockResolvedValue([]);
    mentionApi.capture.mockReset().mockImplementation(async () => ({
      apiBase: "https://api.test",
      sessionGeneration: mentionApi.generation,
      headers: { authorization: "Bearer account-a", "x-rakazo-space-id": "space-a" },
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    render();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("types 20 characters without rendering the parent and sends the latest ref snapshot", () => {
    const mounted = threadRenders;
    const text = "abcdefghijklmnopqrst";
    for (let length = 1; length <= text.length; length += 1) type(text.slice(0, length));
    expect(threadRenders - mounted).toBe(0);
    expect(container.querySelector("input")!.value).toBe(text);
    expect(composer.current!.snapshot().promptText).toBe(text);
    press("Send");
    expect(props.send).toHaveBeenCalledOnce();
  });

  it("loads mention-only catalogs only after typing mention syntax and lets the user select loaded targets", async () => {
    mentionApi.rpc.mockImplementation(async (proc: string) =>
      proc === "routines/list"
        ? [{ id: "routine-1", botId: "bot-1", name: "Morning", crons: [] }]
        : [],
    );
    await act(async () => root.render(<MentionThreadHarness />));
    type("Ordinary text");
    type("mail@example.test");
    expect(mentionApi.rpc).not.toHaveBeenCalled();
    expect(mentionApi.capture).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="mention-picker"]')).toBeNull();
    await act(async () => input.change("Hello @"));
    expect(mentionApi.rpc.mock.calls.map(([proc]) => proc)).toEqual([
      "routines/list",
      "connections/list",
      "connections/catalog",
    ]);
    expect(container.querySelector('[data-testid="mention-picker"]')!.textContent).toContain(
      "Morning",
    );
    type("Hello @Mor");
    press("@{name}");
    expect(composer.current!.snapshot().mentions).toMatchObject([
      { kind: "routine", id: "routine-1", name: "Morning" },
    ]);
    expect(container.querySelector("input")!.value).toBe("Hello ");
    await act(async () => input.change("Again @"));
    expect(mentionApi.rpc).toHaveBeenCalledTimes(3);
  });

  it("continues an existing mention draft after the session is replaced", async () => {
    mentionApi.rpc.mockImplementation(async (proc: string) =>
      proc === "routines/list"
        ? [{ id: `routine-${mentionApi.generation}`, botId: "bot-1", name: "Morning", crons: [] }]
        : [],
    );
    await act(async () => root.render(<MentionThreadHarness />));
    await act(async () => input.change("@Mor"));
    mentionApi.generation = 2;
    await act(async () => root.render(<MentionThreadHarness />));
    expect(container.querySelector("input")!.value).toBe("@Mor");
    await act(async () => input.change("@Morn"));
    expect(mentionApi.rpc).toHaveBeenCalledTimes(6);
    press("@{name}");
    expect(composer.current!.snapshot().mentions).toMatchObject([{ id: "routine-2" }]);
  });

  it("preserves selected chips and the mention draft across a same-target session replacement", async () => {
    mentionApi.rpc.mockImplementation(async (proc: string) =>
      proc === "routines/list"
        ? [{ id: `routine-${mentionApi.generation}`, botId: "bot-1", name: "Morning", crons: [] }]
        : [],
    );
    await act(async () => root.render(<MentionThreadHarness />));
    await act(async () => input.change("@Mor"));
    press("@{name}");
    await act(async () => input.change("Keep @Mor"));
    mentionApi.generation = 2;
    await act(async () => root.render(<MentionThreadHarness />));

    expect(container.querySelector("input")!.value).toBe("Keep @Mor");
    expect(composer.current!.snapshot().mentions).toMatchObject([{ id: "routine-1" }]);
    expect(container.querySelector('[data-testid="mention-picker"]')).toBeNull();
    expect(mentionApi.rpc).toHaveBeenCalledTimes(3);

    await act(async () => input.change("Keep @Morn"));
    expect(mentionApi.rpc).toHaveBeenCalledTimes(6);
    press("@{name}");
    expect(composer.current!.snapshot().mentions).toMatchObject([
      { id: "routine-1" },
      { id: "routine-2" },
    ]);
    expect(container.querySelector("input")!.value).toBe("Keep ");
  });

  it("requires another mention edit after switching the composer target", async () => {
    await act(async () => root.render(<MentionThreadHarness />));
    await act(async () => input.change("@"));
    expect(mentionApi.rpc).toHaveBeenCalledTimes(3);
    mentionApi.rpc.mockClear();
    await act(async () => root.render(<MentionThreadHarness owner="thread-b" />));
    type("New thread");
    expect(mentionApi.rpc).not.toHaveBeenCalled();
    await act(async () => input.change("@"));
    expect(mentionApi.rpc).toHaveBeenCalledTimes(3);
  });

  it("preserves draft across reply, attachment, and sending updates and resets on thread switch", () => {
    type("Draft");
    render({
      replyTargetId: "reply-1",
      replyQuote: "Quote",
      attachmentIds: ["attachment-1"],
      sending: true,
    });
    expect(composer.current!.snapshot()).toMatchObject({
      promptText: "Draft",
      replyTargetId: "reply-1",
      replyQuote: "Quote",
      attachmentIds: ["attachment-1"],
    });
    render({ threadKey: "bot-2" });
    expect(composer.current!.snapshot()).toMatchObject({
      promptText: "",
      mentions: [],
      skill: null,
    });
    expect(container.querySelector("input")!.value).toBe("");
  });

  it("keeps edits during send and clears an unchanged composition, including popovers", () => {
    type("Submitted");
    const submitted = composer.current!.snapshot();
    render({ sending: true });
    type("Dictated replacement @He");
    expect(container.querySelector('[data-testid="mention-picker"]')).not.toBeNull();
    expect(settleComposer(submitted, composer.current!.snapshot()).clearComposer).toBe(false);
    const current = composer.current!.snapshot();
    expect(settleComposer(current, composer.current!.snapshot()).clearComposer).toBe(true);
    act(() => composer.current!.reset());
    expect(composer.current!.snapshot().promptText).toBe("");
    expect(container.querySelector('[data-testid="mention-picker"]')).toBeNull();
  });

  it("selects mention and skill popovers and removes chips with backspace", () => {
    type("Hello @He");
    press("@{name}");
    expect(composer.current!.snapshot().mentions).toEqual([bot]);
    expect(container.querySelector("input")!.value).toBe("Hello ");
    expect(container.querySelector('[data-testid="mention-picker"]')).toBeNull();
    type("/Wri");
    press("Skill {name}");
    expect(composer.current!.snapshot().skill).toEqual(skill);
    expect(container.querySelector("input")!.value).toBe("");
    expect(container.querySelector('[data-testid="slash-picker"]')).toBeNull();
    act(() => input.key({ nativeEvent: { key: "Backspace" } }));
    expect(composer.current!.snapshot().mentions).toEqual([]);
    expect(composer.current!.snapshot().skill).toEqual(skill);
    act(() => input.key({ nativeEvent: { key: "Backspace" } }));
    expect(composer.current!.snapshot().skill).toBeNull();
  });

  it("clears a slash query before routing and uses the call control for an empty draft", () => {
    type("/settings");
    press("Chat Settings");
    expect(props.onSlashAction).toHaveBeenCalledWith("chat-settings");
    expect(container.querySelector("input")!.value).toBe("");
    expect(container.querySelector('[data-testid="slash-picker"]')).toBeNull();
    press("Call");
    expect(props.startVoiceCall).toHaveBeenCalledOnce();
  });

  it("focuses the input when its padding wrapper is pressed without adding an accessibility stop", () => {
    const field = container.querySelector("input")!;
    const wrapper = field.parentElement!;
    expect(wrapper.dataset.accessible).toBe("false");
    expect(document.activeElement).not.toBe(field);
    act(() => wrapper.click());
    expect(document.activeElement).toBe(field);
  });

  it.each([1, 2, 3.2])(
    "keeps a padded scrolling viewport with room for scaled lines at font scale %s",
    (fontScale) => {
      dimensions.fontScale = fontScale;
      const textScale = Math.min(fontScale, MAX_FONT_SCALE);
      render();
      for (const draft of ["Hello", "Hello\nworld", "مرحبا\nبالعالم", "line\n".repeat(20)]) {
        type(draft);
        const field = container.querySelector("input")!;
        const fieldStyle = JSON.parse(field.dataset.style!);
        const wrapperStyle = JSON.parse(field.parentElement!.dataset.style!);
        // Padding belongs outside the native scroll viewport so it cannot scroll away.
        expect(wrapperStyle.paddingVertical).toBe(11);
        expect(fieldStyle.padding).toBe(0);
        expect(fieldStyle.paddingTop).toBeUndefined();
        expect(fieldStyle.paddingBottom).toBeUndefined();
        expect(field.dataset.scrollEnabled).toBe("true");
        expect(fieldStyle.minHeight).toBe(fieldStyle.lineHeight * textScale);
        expect(fieldStyle.maxHeight).toBe(5 * fieldStyle.lineHeight * textScale);
        expect(fieldStyle.height).toBeUndefined();
        expect(fieldStyle.writingDirection).toBe("auto");
      }
      act(() => composer.current!.reset());
      expect(container.querySelector("input")!.value).toBe("");
    },
  );

  it("insets the call and send pills equally from the capsule's bottom and trailing edges", () => {
    const style = (element: Element) => JSON.parse((element as HTMLElement).dataset.style!);
    for (const label of ["Call", "Send"]) {
      if (label === "Send") type("Hello");
      const button = container.querySelector(`button[aria-label="${label}"]`)!;
      const pill = style(button.querySelector("[data-glass]")!);
      const capsule = style(button.closest('[data-glass="roundedRectangle"]')!);
      const inset = (capsule.minHeight - pill.height) / 2;
      expect(style(button).marginBottom).toBe(inset);
      expect(capsule.paddingEnd).toBe(inset);
    }
  });

  it("keeps right-to-left text clear of the call and send pills", () => {
    const style = (element: Element) => JSON.parse((element as HTMLElement).dataset.style!);
    // Right-to-left text runs up to the field's trailing edge, right next to the pill.
    for (const [label, draft] of [
      ["Call", ""],
      ["Send", "אבג"],
      ["Send", "مرحبا\nبالعالم"],
    ] as const) {
      type(draft);
      const button = container.querySelector(`button[aria-label="${label}"]`)!;
      const capsule = style(button.closest('[data-glass="roundedRectangle"]')!);
      expect(capsule.gap).toBe(capsule.paddingEnd);
    }
  });
});
