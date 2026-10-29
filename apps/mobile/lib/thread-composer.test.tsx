// @vitest-environment jsdom

import { buildComposerMentionOptions } from "@rakazo/core";
import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import type { ComponentProps, ReactNode, Ref } from "react";
import { act, Children, createElement, createRef, isValidElement } from "react";
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
  select: (_event: { nativeEvent: { selection: { start: number; end: number } } }) => {},
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
function nativeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (!isValidElement(node)) return "";
  return Children.toArray((node.props as { children?: ReactNode }).children)
    .map(nativeText)
    .join("");
}
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
      children,
      onChangeText,
      onKeyPress,
      onSelectionChange,
      selection,
      style,
      scrollEnabled,
    }: {
      ref?: Ref<HTMLInputElement>;
      children?: ReactNode;
      onChangeText: typeof input.change;
      onKeyPress: typeof input.key;
      onSelectionChange?: typeof input.select;
      selection?: { start: number; end: number };
      style: object;
      scrollEnabled?: boolean;
    }) => {
      input.change = onChangeText;
      input.key = onKeyPress;
      input.select = onSelectionChange ?? (() => {});
      const segments = Children.toArray(children).filter(isValidElement);
      return createElement("input", {
        ref,
        value: segments.map(nativeText).join(""),
        "data-mentions": JSON.stringify(
          segments.filter((segment) => (segment.props as { style?: object }).style).map(nativeText),
        ),
        "data-mention-colors": JSON.stringify(
          segments.map((segment) => (segment.props as { style?: { color?: string } }).style?.color),
        ),
        readOnly: true,
        "data-style": JSON.stringify(style),
        "data-scroll-enabled": scrollEnabled,
        "data-selection": JSON.stringify(selection),
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

  function select(start: number, end = start) {
    act(() => input.select({ nativeEvent: { selection: { start, end } } }));
  }

  function field() {
    return container.querySelector("input")!;
  }

  it("tints a completed mention inline instead of drawing a chip beside the input", () => {
    type("ask @He");
    press("@{name}");
    type("ask @Helper now");
    expect(field().value).toBe("ask @Helper now");
    expect(JSON.parse(field().dataset.mentions!)).toEqual(["@Helper"]);
    expect(container.querySelector('[data-testid="mention-chip"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Remove mention {name}"]')).toBeNull();
  });

  it("colors a bot mention with the bot's identity color", () => {
    render({ composerMentionTargets: [{ ...bot, color: "#3366FF" }] });
    type("ask @He");
    press("@{name}");
    type("ask @Helper now");
    expect(JSON.parse(field().dataset.mentionColors!)).toEqual([null, "#3366FF", null]);
  });

  it("keeps inserted text when backspacing into a mention afterwards", () => {
    type("ask @He");
    press("@{name}");
    act(() => composer.current!.insert("shared text"));
    select(11);
    type("ask @Helpe \nshared text");
    expect(composer.current!.snapshot().promptText).toBe("ask  \nshared text");
    expect(JSON.parse(field().dataset.selection!)).toEqual({ start: 4, end: 4 });
    expect(composer.current!.snapshot().mentions).toEqual([]);
  });

  it("keeps a selected bot at its inline position and continues typing after it", () => {
    type("i need u to message @He");
    press("@{name}");
    expect(container.querySelector("input")!.value).toBe("i need u to message @Helper ");
    expect(JSON.parse(container.querySelector("input")!.dataset.selection!)).toEqual({
      start: 28,
      end: 28,
    });
    type("i need u to message @Helper and do this");
    expect(composer.current!.snapshot().promptText).toBe("i need u to message @Helper and do this");
    expect(composer.current!.snapshot().mentions).toEqual([bot]);
  });

  it("replaces only the active query in existing text and keeps suffix whitespace", () => {
    type("i need u to message @He  and do this");
    select("i need u to message @He".length);
    press("@{name}");
    expect(container.querySelector("input")!.value).toBe(
      "i need u to message @Helper  and do this",
    );
    expect(JSON.parse(container.querySelector("input")!.dataset.selection!)).toEqual({
      start: 28,
      end: 28,
    });
    expect(composer.current!.snapshot().promptText).toBe(
      "i need u to message @Helper  and do this",
    );
  });

  it("replaces the full query when the caret is inside it and ignores a selected range", () => {
    type("before @Hel after");
    select(8, 11);
    expect(container.querySelector('[data-testid="mention-picker"]')).toBeNull();
    select(10);
    press("@{name}");
    expect(container.querySelector("input")!.value).toBe("before @Helper after");
    expect(JSON.parse(container.querySelector("input")!.dataset.selection!)).toEqual({
      start: 15,
      end: 15,
    });
  });

  it("replaces routing metadata when completing over an already selected token", () => {
    const other = { kind: "bot", id: "bot-3", name: "HelperOther" } as const;
    render({ composerMentionTargets: [bot, other] });
    type("before @He");
    press("@{name}");
    expect(composer.current!.snapshot().mentions).toEqual([bot]);
    select(10);
    const options = container.querySelectorAll<HTMLButtonElement>('button[aria-label="@{name}"]');
    expect(options).toHaveLength(2);
    act(() => options[1]!.click());
    expect(container.querySelector("input")!.value).toBe("before @HelperOther ");
    expect(composer.current!.snapshot().mentions).toEqual([other]);
  });

  function pickMentionAt(index: number) {
    const options = container.querySelectorAll<HTMLButtonElement>('button[aria-label="@{name}"]');
    expect(options.length).toBeGreaterThan(index);
    act(() => options[index]!.click());
  }

  it("replaces a selected group binding with a bot sharing its name at the same occurrence", () => {
    const group = { kind: "group", id: "group-1", name: "Helper" } as const;
    render({ composerMentionTargets: [group, bot] });
    type("before @He");
    pickMentionAt(0);
    expect(composer.current!.snapshot().mentions).toMatchObject([group]);
    select(10);
    pickMentionAt(1);
    expect(container.querySelector("input")!.value).toBe("before @Helper ");
    expect(composer.current!.snapshot().mentions).toEqual([bot]);
  });

  const bobBot = { kind: "bot", id: "bob-bot", name: "Bob" } as const;
  const bobGroup = { kind: "group", id: "bob-group", name: "Bob" } as const;

  function selectBothBobs(separator = "and ") {
    render({ composerMentionTargets: [bobBot, bobGroup] });
    type("@Bo");
    pickMentionAt(0);
    type(`@Bob ${separator}@Bo`);
    pickMentionAt(1);
    expect(composer.current!.snapshot().mentions).toMatchObject([bobBot, bobGroup]);
  }

  it("removes only the deleted group binding when a bot has the same name", () => {
    selectBothBobs();
    select(9, 13);
    type("@Bob and  ");
    select(9);
    expect(composer.current!.snapshot().mentions).toEqual([bobBot]);
  });

  it.each(["text-first", "selection-first"])(
    "retains the second identity when deleting an identical first token with %s events",
    (order) => {
      selectBothBobs("");
      select(0, 5);
      if (order === "selection-first") select(0);
      type("@Bob ");
      if (order === "text-first") select(0);
      expect(composer.current!.snapshot().mentions).toMatchObject([
        { ...bobGroup, ranges: [{ start: 0, end: 4 }] },
      ]);
    },
  );

  it("uses the latest native caret after a previous selection when deleting identical tokens", () => {
    selectBothBobs("");
    select(0, 5);
    select(10);
    type("@Bob ");
    select(5);
    expect(composer.current!.snapshot().mentions).toEqual([bobBot]);
  });

  it.each(["text-first", "selection-first"])(
    "backspacing into a same-name mention removes only that identity (%s events)",
    (order) => {
      for (const index of [0, 1]) {
        selectBothBobs();
        const end = index === 0 ? 4 : 13;
        select(end);
        if (order === "selection-first") select(end - 1);
        type(index === 0 ? "@Bo and @Bob " : "@Bob and @Bo ");
        expect(field().value).toBe(index === 0 ? " and @Bob " : "@Bob and  ");
        expect(JSON.parse(field().dataset.selection!)).toEqual({
          start: end - 4,
          end: end - 4,
        });
        expect(composer.current!.snapshot().mentions).toMatchObject(
          index === 0 ? [bobGroup] : [bobBot],
        );
      }
    },
  );

  it("widens a selection that cuts into a mention and keeps the caret where it started", () => {
    type("before @He");
    press("@{name}");
    type("before @Helper alpha omega");
    select(3, 10);
    type("beflper alpha omega");
    expect(field().value).toBe("bef alpha omega");
    expect(JSON.parse(field().dataset.selection!)).toEqual({ start: 3, end: 3 });
    expect(composer.current!.snapshot().mentions).toEqual([]);
  });

  it.each(["bot", "group"] as const)(
    "retires a shorter %s mention when replacing it with a multiword bot name",
    (kind) => {
      const shorter = { ...bot, kind };
      const longer = { kind: "bot", id: "bot-3", name: "Helper Smith" } as const;
      render({ composerMentionTargets: [shorter, longer] });
      type("before @He");
      pickMentionAt(0);
      select(10);
      pickMentionAt(1);
      expect(container.querySelector("input")!.value).toBe("before @Helper Smith ");
      expect(composer.current!.snapshot().mentions).toEqual([longer]);
    },
  );

  it("keeps a separate shorter mention when replacing another occurrence with a longer name", () => {
    const longer = { kind: "bot", id: "bot-3", name: "Helper Smith" } as const;
    render({ composerMentionTargets: [bot, longer] });
    type("@He");
    pickMentionAt(0);
    type("@Helper and @He");
    pickMentionAt(0);
    select("@Helper and @He".length);
    pickMentionAt(1);
    expect(container.querySelector("input")!.value).toBe("@Helper and @Helper Smith ");
    expect(composer.current!.snapshot().mentions).toEqual([bot, longer]);
    type("and @Helper Smith ");
    expect(composer.current!.snapshot().mentions).toEqual([longer]);
  });

  it("replaces the entire recognized multiword name when the caret is inside its first word", () => {
    const smith = { kind: "bot", id: "bot-3", name: "Helper Smith" } as const;
    const jones = { kind: "bot", id: "bot-4", name: "Helper Jones" } as const;
    render({ composerMentionTargets: [smith, jones] });
    type("before @He");
    pickMentionAt(0);
    select(10);
    pickMentionAt(1);
    expect(container.querySelector("input")!.value).toBe("before @Helper Jones ");
    expect(composer.current!.snapshot().mentions).toEqual([jones]);
  });

  it("backspacing into a shorter mention leaves a longer recognized name intact", () => {
    const longer = { kind: "bot", id: "bot-3", name: "Helper Smith" } as const;
    render({ composerMentionTargets: [bot, longer] });
    type("@He");
    pickMentionAt(0);
    type("@Helper and @He");
    pickMentionAt(1);
    select(7);
    type("@Helpe and @Helper Smith ");
    expect(field().value).toBe(" and @Helper Smith ");
    expect(composer.current!.snapshot().mentions).toEqual([longer]);
  });

  it.each(["text-first", "selection-first"])(
    "finds the query when native editing events arrive %s",
    (order) => {
      type("before  after");
      select(7);
      if (order === "selection-first") select(10);
      type("before @He after");
      if (order === "text-first") select(10);
      press("@{name}");
      expect(container.querySelector("input")!.value).toBe("before @Helper after");
      expect(composer.current!.snapshot().promptText).toBe("before @Helper after");
    },
  );

  it("leaves the native caret in control while editing repeated characters", () => {
    type("aaa");
    select(1);
    select(2);
    type("aaaa");
    expect(container.querySelector("input")!.dataset.selection).toBeUndefined();
    expect(container.querySelector("input")!.value).toBe("aaaa");
  });

  it("keeps the picker dismissed after restoring the completed caret before punctuation", () => {
    type("before @He, after");
    select(10);
    press("@{name}");
    expect(container.querySelector("input")!.value).toBe("before @Helper, after");
    select(14);
    expect(container.querySelector('[data-testid="mention-picker"]')).toBeNull();
    select(8);
    expect(container.querySelector('[data-testid="mention-picker"]')).not.toBeNull();
  });

  it("keeps repeated mentions in text and prunes metadata only after the final token is deleted", () => {
    type("first @He");
    press("@{name}");
    type("first @Helper then @He");
    press("@{name}");
    expect(container.querySelector("input")!.value).toBe("first @Helper then @Helper ");
    expect(composer.current!.snapshot().promptText).toBe("first @Helper then @Helper");
    expect(composer.current!.snapshot().mentions).toEqual([bot]);
    type("first then @Helper ");
    expect(composer.current!.snapshot().mentions).toEqual([bot]);
    type("first then done");
    expect(composer.current!.snapshot().mentions).toEqual([]);
  });

  it("removes one repeated mention token at a time without rewriting whitespace", () => {
    type("first @He");
    press("@{name}");
    type("first @Helper  then @He");
    press("@{name}");
    select(27);
    type("first @Helper  then @Helpe ");
    expect(field().value).toBe("first @Helper  then  ");
    expect(composer.current!.snapshot().mentions).toEqual([bot]);
    select(13);
    type("first @Helpe  then  ");
    expect(field().value).toBe("first   then  ");
    expect(composer.current!.snapshot().mentions).toEqual([]);
  });

  it("removes the mention when its own @ is deleted after a selection-first event", () => {
    type("@ @He");
    press("@{name}");
    select(2);
    type("@@Helper ");
    select(2);
    select(1);
    type("@Helper ");
    expect(field().value).toBe("@ ");
    expect(JSON.parse(field().dataset.selection!)).toEqual({ start: 1, end: 1 });
    expect(composer.current!.snapshot().mentions).toEqual([]);
  });

  it("deletes a stray character beside a mention without taking the mention", () => {
    type("@ @He");
    press("@{name}");
    select(2);
    type("@@Helper ");
    expect(field().value).toBe("@@Helper ");
    select(1);
    type("@Helper ");
    select(0);
    expect(field().value).toBe("@Helper ");
    expect(composer.current!.snapshot().mentions).toEqual([bot]);
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
    // Routine reads are batched a microtask later, so only the set of reads is stable.
    expect(mentionApi.rpc.mock.calls.map(([proc]) => proc).sort()).toEqual([
      "connections/catalog",
      "connections/list",
      "routines/list",
    ]);
    expect(container.querySelector('[data-testid="mention-picker"]')!.textContent).toContain(
      "Morning",
    );
    type("Hello @Mor");
    press("@{name}");
    expect(composer.current!.snapshot().mentions).toMatchObject([
      { kind: "routine", id: "routine-1", name: "Morning" },
    ]);
    expect(container.querySelector("input")!.value).toBe("Hello @Morning ");
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
    await act(async () => input.change("@Morning Keep @Mor"));
    mentionApi.generation = 2;
    await act(async () => root.render(<MentionThreadHarness />));

    expect(container.querySelector("input")!.value).toBe("@Morning Keep @Mor");
    expect(composer.current!.snapshot().mentions).toMatchObject([{ id: "routine-1" }]);
    expect(container.querySelector('[data-testid="mention-picker"]')).toBeNull();
    expect(mentionApi.rpc).toHaveBeenCalledTimes(3);

    await act(async () => input.change("@Morning Keep @Morn"));
    expect(mentionApi.rpc).toHaveBeenCalledTimes(6);
    press("@{name}");
    expect(composer.current!.snapshot().mentions).toMatchObject([
      { id: "routine-1" },
      { id: "routine-2" },
    ]);
    expect(container.querySelector("input")!.value).toBe("@Morning Keep @Morning ");
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

  it("selects mention and skill popovers, clears replaced mentions, and removes skills with backspace", () => {
    type("Hello @He");
    press("@{name}");
    expect(composer.current!.snapshot().mentions).toEqual([bot]);
    expect(container.querySelector("input")!.value).toBe("Hello @Helper ");
    expect(container.querySelector('[data-testid="mention-picker"]')).toBeNull();
    type("/Wri");
    press("Skill {name}");
    expect(composer.current!.snapshot().skill).toEqual(skill);
    expect(container.querySelector("input")!.value).toBe("");
    expect(container.querySelector('[data-testid="slash-picker"]')).toBeNull();
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
