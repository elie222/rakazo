// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { foldPeerReplies } from "@rakazo/core";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { act } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../../lib/query/rpc";
import { useShellShortcuts } from "../shell-shortcuts";
import { Transcript } from "./transcript";

const stableT = (strings: TemplateStringsArray, ...values: unknown[]) =>
  String.raw(strings, ...values);

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: stableT }),
}));

vi.mock("@lingui/core/macro", () => ({
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

vi.mock("../../../lib/query/rpc", () => ({ rpc: {} }));

let container: HTMLDivElement;
let root: Root;
let scrollRef: RefObject<HTMLDivElement | null>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  scrollRef = { current: container };
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let seq = 0;
function at(minutes: number) {
  return new Date(2026, 0, 1, 10, minutes).toISOString();
}

function textMessage(id: string, role: "user" | "bot", text: string): ThreadMessage {
  seq += 1;
  return {
    id,
    threadId: "thread",
    seq,
    role,
    createdAt: at(seq),
    blocks: [{ kind: "text", text }],
  };
}

function liveMessage(text: string): ThreadMessage {
  return {
    id: "progress:run",
    threadId: "thread",
    seq: 9999,
    role: "bot",
    createdAt: at(120),
    blocks: [{ kind: "progress", text }],
  };
}

function history(): ThreadMessage[] {
  return [
    textMessage("m1", "user", "Book a weekend in the mountains"),
    textMessage("m2", "bot", "Looking at cabins near Zakopane"),
    textMessage("m3", "bot", "Atlas will pick the dates"),
    textMessage("m4", "user", "Sounds good"),
  ];
}

function baseProps(messages: readonly ThreadMessage[]): ComponentProps<typeof Transcript> {
  return {
    scrollRef,
    scrollRequest: null,
    onScrollRequestHandled: vi.fn(),
    followRequest: 0,
    callHoldsSpeaker: false,
    artifactTarget: { botId: "bot" },
    transcript: foldPeerReplies(messages, { includePeerReceipts: true }),
    showToolActivity: false,
    olderCursor: null,
    unreadAfterSeq: null,
    loadingOlder: false,
    answerableAskIds: new Set<string>(),
    dismissableAskIds: new Set<string>(),
    running: true,
    workingBots: [{ botId: "bot", color: "orange", status: "running" }],
    onLoadOlder: vi.fn(),
    onOpenBot: vi.fn(),
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onMarkUnread: vi.fn(),
    onQuote: vi.fn(),
    onReact: vi.fn(),
    onJumpToMessage: vi.fn(),
    onOpenPeerMessages: vi.fn(),
    peerBot: () => ({ name: "Atlas", color: "orange" }),
    onRefresh: vi.fn(),
    onBotChanged: vi.fn(),
    onAddRoutine: vi.fn(),
    voiceReady: false,
    speakingMessageId: null,
    onSpeak: vi.fn(),
    onOpenComputer: vi.fn(),
    onReleaseComputer: vi.fn(),
    rpc,
  };
}

function render(props: ComponentProps<typeof Transcript>) {
  act(() => root.render(<Transcript {...props} />));
}

function selectText(element: Element, text: string, notify = true) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && !node.textContent?.includes(text)) node = walker.nextNode();
  if (!node) throw new Error(`Text not found: ${text}`);
  const range = document.createRange();
  const start = node.textContent!.indexOf(text);
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  if (notify) act(() => document.dispatchEvent(new Event("selectionchange")));
}

it("shares the armed quote action with the pill and replaces quotes on new selections", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 100, bottom: 120, left: 100, width: 40 }) as DOMRect;
  const props = baseProps(history());
  const armed: { current: (() => boolean) | null } = { current: null };
  const register = (handler: (() => boolean) | null) => {
    armed.current = handler;
  };
  function Harness() {
    useShellShortcuts({
      run: (shortcut) => shortcut.type === "quote-selection" && (armed.current?.() ?? false),
      onTyping: () => {},
    });
    return <Transcript {...props} onQuoteShortcutChange={register} />;
  }
  act(() => root.render(<Harness />));
  const press = () => {
    const event = new KeyboardEvent("keydown", {
      key: "L",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  };
  expect(armed.current).toBeNull();
  expect(press().defaultPrevented).toBe(false);
  selectText(container.querySelector('[data-message-id="m2"]')!, "cabins near");
  expect(armed.current).not.toBeNull();
  expect(press().defaultPrevented).toBe(true);
  expect(props.onQuote).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "m2" }),
    "cabins near",
  );
  expect(window.getSelection()?.isCollapsed).toBe(true);
  expect(armed.current).toBeNull();
  expect(document.querySelector("[data-quote-selection]")).toBeNull();

  selectText(container.querySelector('[data-message-id="m3"]')!, "pick the dates");
  expect(press().defaultPrevented).toBe(true);
  expect(props.onQuote).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "m3" }),
    "pick the dates",
  );
  selectText(container.querySelector('[data-message-id="m2"]')!, "Zakopane");
  act(() => document.querySelector<HTMLButtonElement>('[data-testid="quote-selection"]')!.click());
  expect(props.onQuote).toHaveBeenLastCalledWith(expect.objectContaining({ id: "m2" }), "Zakopane");
  expect(props.onQuote).toHaveBeenCalledTimes(3);
});

it("keeps the quote draft for an Escape another handler consumed", () => {
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 100, bottom: 120, left: 100, width: 40 }) as DOMRect;
  act(() => root.render(<Transcript {...baseProps(history())} />));
  selectText(container.querySelector('[data-message-id="m2"]')!, "cabins near");
  const pill = () => document.querySelector("[data-quote-selection]");
  expect(pill()).not.toBeNull();

  // The phone drawer closing on Escape prevents the default on document.
  const consume = (event: Event) => event.preventDefault();
  document.addEventListener("keydown", consume);
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  document.removeEventListener("keydown", consume);
  expect(pill()).not.toBeNull();

  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(pill()).toBeNull();
});

it("rejects cleared, outside and composer selections even before selectionchange", () => {
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 100, bottom: 120, left: 100, width: 40 }) as DOMRect;
  const props = baseProps(history());
  const armed: { current: (() => boolean) | null } = { current: null };
  const register = (handler: (() => boolean) | null) => {
    armed.current = handler;
  };
  render({ ...props, onQuoteShortcutChange: register });
  const arm = () => selectText(container.querySelector('[data-message-id="m2"]')!, "cabins near");
  arm();
  window.getSelection()?.removeAllRanges();
  expect(armed.current!()).toBe(false);
  arm();
  const outside = document.createElement("div");
  outside.textContent = "Outside text";
  document.body.append(outside);
  selectText(outside, "Outside", false);
  expect(armed.current!()).toBe(false);
  outside.remove();
  arm();
  const composer = document.createElement("textarea");
  composer.value = "Draft text";
  document.body.append(composer);
  composer.focus();
  composer.setSelectionRange(0, 5);
  expect(armed.current!()).toBe(false);
  composer.remove();
  expect(props.onQuote).not.toHaveBeenCalled();
  act(() => document.dispatchEvent(new Event("selectionchange")));
  act(() => root.unmount());
  expect(armed.current).toBeNull();
  root = createRoot(container);
});

it.each([
  ["MacIntel", "⌘⇧L"],
  ["Linux", "Ctrl+Shift+L"],
])("shows the shortcut hint on %s", (platform, hint) => {
  const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 100, bottom: 120, left: 100, width: 40 }) as DOMRect;
  render(baseProps(history()));
  selectText(container.querySelector('[data-message-id="m2"]')!, "cabins near");
  expect(document.querySelector('[data-testid="quote-selection"]')?.textContent).toContain(hint);
  platformSpy.mockRestore();
});

it("drops the quote pill when a streaming edit replaces the selected nodes", async () => {
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, width: 0 }) as DOMRect;
  const historyMessages = history();
  const props = baseProps([...historyMessages, liveMessage("Drafting")]);
  render(props);
  const row = container.querySelector<HTMLElement>('[data-message-id="m2"]')!;
  const select = (needle: string) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node && !node.textContent?.includes(needle)) node = walker.nextNode() as Text | null;
    if (!node) throw new Error(`needle ${needle} not found`);
    const range = document.createRange();
    range.setStart(node, node.textContent!.indexOf(needle));
    range.setEnd(node, node.textContent!.indexOf(needle) + needle.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
  };

  select("cabins near");
  expect(document.querySelector("[data-quote-selection]")).not.toBeNull();
  const range = window.getSelection()!.getRangeAt(0);
  expect(range.collapsed).toBe(false);

  // The stream rewrites the message with new markdown structure, replacing
  // the nodes the selection covered.
  const rewritten = historyMessages.map((message) =>
    message.id === "m2"
      ? {
          ...message,
          blocks: [{ kind: "text" as const, text: "Looking at **cabins** near Zakopane" }],
        }
      : message,
  );
  render({
    ...props,
    transcript: foldPeerReplies([...rewritten, liveMessage("Drafting")], {
      includePeerReceipts: true,
    }),
  });

  expect(window.getSelection()!.getRangeAt(0).collapsed).toBe(true);
  expect(document.querySelector("[data-quote-selection]")).toBeNull();
});

it("drops the quote pill when an edit removes only one end of the selection", async () => {
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, width: 0 }) as DOMRect;
  const messages = history().map((message) =>
    message.id === "m2"
      ? {
          ...message,
          blocks: [{ kind: "text" as const, text: "Looking at **cabins** near Zakopane" }],
        }
      : message,
  );
  const props = baseProps([...messages, liveMessage("Drafting")]);
  render(props);
  const row = container.querySelector<HTMLElement>('[data-message-id="m2"]')!;
  const textNode = (needle: string) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node && !node.textContent?.includes(needle)) node = walker.nextNode() as Text | null;
    if (!node) throw new Error(`needle ${needle} not found`);
    return node;
  };
  const start = textNode("Looking at");
  const end = textNode("near Zakopane");
  const range = document.createRange();
  range.setStart(start, start.textContent!.indexOf("at"));
  range.setEnd(end, end.textContent!.indexOf("near") + "near".length);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(document.querySelector("[data-quote-selection]")).not.toBeNull();

  // An edit replaces only the node holding the start: the range moves without collapsing.
  start.remove();
  render({
    ...props,
    transcript: foldPeerReplies([...messages, liveMessage("Drafting more")], {
      includePeerReceipts: true,
    }),
  });

  expect(window.getSelection()!.getRangeAt(0).collapsed).toBe(false);
  expect(document.querySelector("[data-quote-selection]")).toBeNull();
});

/** Renders outside act, so the first commit is visible before the transition mounts the rest. */
async function renderFirstFrame(props: ComponentProps<typeof Transcript>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  flushSync(() => root.render(<Transcript {...props} />));
  const first = [...container.querySelectorAll("[data-message-id]")].map((row) =>
    row.getAttribute("data-message-id"),
  );
  await vi.waitFor(() =>
    expect(container.querySelectorAll("[data-message-id]").length).toBeGreaterThan(first.length),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return first;
}

it("paints a chat's latest rows first, then mounts its history", async () => {
  const messages = Array.from({ length: 30 }, (_, index) =>
    textMessage(`t${index}`, index % 2 ? "bot" : "user", `Message ${index}`),
  );
  const first = await renderFirstFrame({ ...baseProps(messages), running: false });
  expect(first).toEqual(messages.slice(-20).map((message) => message.id));
  expect(container.querySelectorAll("[data-message-id]")).toHaveLength(30);
});

it("does not spend the first frame on rows hidden tool activity would leave blank", async () => {
  const shown = Array.from({ length: 3 }, (_, index) =>
    textMessage(`shown${index}`, "user", `Question ${index}`),
  );
  const tools: ThreadMessage[] = Array.from({ length: 25 }, (_, index) => {
    seq += 1;
    return {
      id: `tool${index}`,
      threadId: "thread",
      seq,
      role: "bot",
      createdAt: at(seq),
      blocks: [{ kind: "steps", steps: [{ label: "Searched the web", count: 1 }] }],
    };
  });
  const props = { ...baseProps([...shown, ...tools]), running: false };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  flushSync(() => root.render(<Transcript {...props} />));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  expect(
    [...container.querySelectorAll("[data-message-id]")].map((row) =>
      row.getAttribute("data-message-id"),
    ),
  ).toEqual(shown.map((message) => message.id));
});

it("follows a reply to the reader's message until its first line reaches the top", () => {
  const sent = history();
  render(baseProps(sent));
  render({ ...baseProps(sent), followRequest: 1 });
  const rowTops = { m5: 900 };
  const { transcript, size, scrollTo } = measuredTranscript(rowTops);
  transcript.scrollTop = 500;
  transcript.style.scrollPaddingTop = "64px";
  const reply = textMessage("m5", "bot", "Here are three cabins");

  scrollTo.mockClear();
  size.content = 1_200;
  render({ ...baseProps([...sent, reply]), followRequest: 1 });
  // The whole reply fits: keep following to the end.
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 1_200, behavior: "auto" });

  scrollTo.mockClear();
  transcript.scrollTop = 700;
  rowTops.m5 = 200;
  size.content = 2_000;
  render({
    ...baseProps([...sent, { ...reply, blocks: [{ kind: "text", text: "Long" }] }]),
    followRequest: 1,
  });
  // Its start would scroll away: hold it under the header (row at 700 + 200, less 64px padding).
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 836, behavior: "auto" });

  scrollTo.mockClear();
  size.content = 2_500;
  render({
    ...baseProps([...sent, { ...reply, blocks: [{ kind: "text", text: "Longer" }] }]),
    followRequest: 1,
  });
  expect(scrollTo).not.toHaveBeenCalled();
});

function measuredTranscript(rowTops: Record<string, number>) {
  const transcript = container.querySelector<HTMLElement>('[data-testid="transcript"]');
  if (!transcript) throw new Error("transcript missing");
  const size = { content: 1_000 };
  Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 500 });
  Object.defineProperty(transcript, "scrollHeight", {
    configurable: true,
    get: () => size.content,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return {
      top: this === transcript ? 0 : (rowTops[this.dataset.messageId ?? ""] ?? 0),
    } as DOMRect;
  });
  const scrollTo = vi.mocked(transcript.scrollTo).mockImplementation(((
    options: ScrollToOptions,
  ) => {
    transcript.scrollTop = options.top ?? 0;
  }) as typeof transcript.scrollTo);
  return { transcript, size, scrollTo };
}

it("keeps holding a reply whose start sits near the end", () => {
  const sent = history();
  render(baseProps(sent));
  render({ ...baseProps(sent), followRequest: 1 });
  const { transcript, size, scrollTo } = measuredTranscript({ m5: 0 });
  const reply = textMessage("m5", "bot", "Here are three cabins");
  transcript.scrollTop = 1_000;
  size.content = 1_530;
  render({ ...baseProps([...sent, reply]), followRequest: 1 });
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 1_000, behavior: "auto" });

  // The hold's own scroll lands within the near-end band; it must not resume following.
  act(() => {
    transcript.dispatchEvent(new Event("scroll", { bubbles: true }));
    transcript.dispatchEvent(new Event("scrollend", { bubbles: true }));
  });
  scrollTo.mockClear();
  size.content = 3_000;
  render({
    ...baseProps([...sent, { ...reply, blocks: [{ kind: "text", text: "Long" }] }]),
    followRequest: 1,
  });
  expect(scrollTo).not.toHaveBeenCalled();
});

it("follows later messages to the end once a reply that fit has finished", () => {
  const sent = history();
  render(baseProps(sent));
  render({ ...baseProps(sent), followRequest: 1 });
  const { size, scrollTo } = measuredTranscript({ m5: 900 });
  const reply = textMessage("m5", "bot", "Done");
  size.content = 1_200;
  render({ ...baseProps([...sent, reply]), followRequest: 1, running: false });
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 1_200, behavior: "auto" });

  size.content = 5_000;
  render({
    ...baseProps([...sent, reply, textMessage("m6", "bot", "A routine finished")]),
    followRequest: 1,
    running: false,
  });
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 5_000, behavior: "auto" });
});

it("lets a tap at a held reply near the end resume following", () => {
  const sent = history();
  render(baseProps(sent));
  render({ ...baseProps(sent), followRequest: 1 });
  const { transcript, size, scrollTo } = measuredTranscript({ m5: 0 });
  const reply = textMessage("m5", "bot", "Here are three cabins");
  transcript.scrollTop = 1_000;
  size.content = 1_530;
  render({ ...baseProps([...sent, reply]), followRequest: 1 });

  act(() => {
    transcript.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  scrollTo.mockClear();
  size.content = 3_000;
  render({
    ...baseProps([...sent, { ...reply, blocks: [{ kind: "text", text: "Long" }] }]),
    followRequest: 1,
  });
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 3_000, behavior: "auto" });
});

it("holds the new reply, not older history that loads after the send", () => {
  const sent = history();
  render(baseProps(sent));
  render({ ...baseProps(sent), followRequest: 1 });
  const { transcript, size, scrollTo } = measuredTranscript({ m0: -500, m5: 200 });
  transcript.scrollTop = 700;
  size.content = 2_000;
  render({
    ...baseProps([
      textMessage("m0", "bot", "An older answer"),
      ...sent,
      textMessage("m5", "bot", "Here are three cabins"),
    ]),
    followRequest: 1,
  });
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 900, behavior: "auto" });
});

function liveRegion() {
  return container.querySelector('[data-testid="reply-announcement"]')?.textContent ?? "";
}

it("announces a finished bot reply once, not streaming, history, first load or your own messages", () => {
  const initial = history();
  render(baseProps(initial));
  expect(liveRegion()).toBe("");

  const streaming = [...initial, liveMessage("Checking")];
  render(baseProps(streaming));
  render(baseProps([...initial, liveMessage("Checking the dates")]));
  expect(liveRegion()).toBe("");

  const reply = { ...textMessage("m5", "bot", "**Booked** the cabin for May"), botId: "bot" };
  const withReply = [...initial, reply];
  render(baseProps(withReply));
  expect(liveRegion()).toBe("Atlas: Booked the cabin for May");

  const own = [...withReply, textMessage("m6", "user", "Thanks")];
  render(baseProps(own));
  expect(liveRegion()).toBe("Atlas: Booked the cabin for May");

  const earlier = { ...textMessage("m0", "bot", "An older answer"), seq: 0 };
  render(baseProps([earlier, ...own]));
  expect(liveRegion()).toBe("Atlas: Booked the cabin for May");
});

it("announces the first reply in a thread that opened empty", () => {
  render(baseProps([]));
  expect(liveRegion()).toBe("");
  render(baseProps([{ ...textMessage("m1", "bot", "Hello there"), botId: "bot" }]));
  expect(liveRegion()).toBe("Atlas: Hello there");
});
