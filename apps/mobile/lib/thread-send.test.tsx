// @vitest-environment jsdom
import type { MessageBlock } from "@rakazo/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { rpc } from "./api";
import { hapticImpact, hapticSuccess } from "./haptics";
import * as feedbackModule from "./thread-feedback";

const navigation = vi.hoisted(() => ({
  focused: true,
  isFocused() {
    return this.focused;
  },
}));

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("./haptics", () => ({ hapticImpact: vi.fn(), hapticSuccess: vi.fn() }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useNavigation: () => navigation,
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example",
  rpc: vi.fn(),
  selectedSpaceId: () => null,
}));
vi.mock("./i18n", () => ({ t: (text: string) => text, useI18n: () => ({ t: (s: string) => s }) }));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: async () => undefined }));
vi.mock("./focus-prompt", () => ({ cancelFocusPrompt: () => undefined }));
vi.mock("./unsent-sends", () => ({ prepareUnsentSends: async () => undefined }));
vi.mock("./session", () => ({
  loadSessionToken: async () => "token",

  currentSessionGeneration: () => 1,
  registerSessionDiskCache: () => undefined,
}));
vi.mock("./page-runtime", () => ({ loadPageRuntime: async () => "" }));

const { useThreadSend } = await import("./thread-send");
const { deliverSend } = feedbackModule;
const { offerPageReply } = await import("./pages");

type Sender = ReturnType<typeof useThreadSend>;
const card = (id: string, pageId: string): { id: string; role: "bot"; blocks: MessageBlock[] } => ({
  id,
  role: "bot",
  blocks: [{ kind: "page", pageId, version: 1, title: `Page ${pageId}` }],
});
const said = (id: string, text: string) => ({
  id,
  role: "user" as const,
  blocks: [{ kind: "text" as const, text }],
});

/** The chat's sender with `messages` loaded, a composer holding what replies add to it. */
async function chat(messages: object[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const payloads: unknown[] = [];
  let sender!: Sender;
  let draft = "";
  const feedback = {
    setError: () => undefined,
    sendAttempt: (payload: unknown) => {
      payloads.push(payload);
      return { payload, clientNonce: "n1", artifactIds: new Map(), state: "queued" };
    },
    send: async () => undefined,
  };
  function Harness() {
    sender = useThreadSend({
      botId: "bot-1",
      readOnly: false,
      threadKey: "bot-1",
      history: {
        snapRef: { current: { messages } },
        pinnedAroundRef: { current: null },
        jumpScrollTarget: { current: null },
      },
      scroll: { follow: () => undefined, behavior: { current: { onOwnSend: () => undefined } } },
      feedback,
      attachments: {
        pendingAttachments: [],
        setPendingAttachments: () => undefined,
        setAttachmentNotice: () => undefined,
        importingShare: { current: false },
      },
      mentionBotsRef: { current: [] },
      activeBotId: { current: "bot-1" },
      activeGroupId: { current: undefined },
      isCurrentTarget: () => true,
      refresh: async () => undefined,
      showLatest: () => undefined,
      markCaughtUp: () => undefined,
      openBotChat: () => undefined,
    } as never);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
  sender.composerRef.current = {
    snapshot: () => ({
      promptText: draft,
      mentions: [],
      skill: null,
      replyTargetId: sender.replyTarget?.id,
      replyQuote: sender.replyQuote,
      attachmentIds: [],
    }),
    addReply: (text: string) => {
      draft = draft ? `${draft} ${text}` : text;
    },
    reset: () => {
      draft = "";
    },
  } as never;
  /** What the server receives for the composer's message. */
  const sent = async (): Promise<Record<string, unknown> | undefined> => {
    payloads.length = 0;
    await act(async () => sender.send());
    const request = vi.fn(async () => ({ seq: 1 }));
    const payload = payloads.at(-1) as Parameters<typeof deliverSend>[0];
    const attempt = { clientNonce: "n1", artifactIds: new Map() };
    await deliverSend(payload, attempt as never, request as never);
    return payload
      ? ((request.mock.calls.at(-1) as unknown[] | undefined)?.[1] as never)
      : undefined;
  };
  return {
    sender: () => sender,
    root,
    sent,
    tapOnPage: (pageId: string, title: string, text: string) =>
      act(async () => {
        offerPageReply("bot-1", { text, page: { id: pageId, title } });
        sender.receivePageReply();
      }),
  };
}

it("taps only valid sends and confirms delivery only for the visible chat", async () => {
  let delivered!: Parameters<typeof feedbackModule.subscribeDelivered>[0];
  const subscription = vi
    .spyOn(feedbackModule, "subscribeDelivered")
    .mockImplementation((listener) => {
      delivered = listener;
      return () => {};
    });
  const view = await chat([]);
  vi.mocked(hapticImpact).mockClear();
  vi.mocked(hapticSuccess).mockClear();
  try {
    await act(async () => view.sender().send());
    expect(hapticImpact).not.toHaveBeenCalled();
    view.sender().composerRef.current?.addReply("Hello");
    await act(async () => view.sender().send());
    expect(hapticImpact).toHaveBeenCalledTimes(1);
    expect(hapticSuccess).not.toHaveBeenCalled();
    const attempt = {
      payload: {
        originThreadKey: "bot-1",
        initialBotTarget: "bot-1",
        botTarget: "bot-1",
        plan: {},
      },
    } as Parameters<typeof delivered>[0];
    delivered(attempt);
    expect(hapticSuccess).toHaveBeenCalledTimes(1);
    navigation.focused = false;
    delivered(attempt);
    navigation.focused = true;
    delivered({ ...attempt, payload: { ...attempt.payload, originThreadKey: "bot-2" } });
    expect(hapticSuccess).toHaveBeenCalledTimes(1);
  } finally {
    navigation.focused = true;
    await act(async () => view.root.unmount());
    subscription.mockRestore();
  }
});

it("does not confirm a card answer accepted after navigation leaves the mounted chat", async () => {
  let accept!: () => void;
  vi.mocked(rpc).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      accept = resolve;
    }) as never,
  );
  const view = await chat([]);
  vi.mocked(hapticSuccess).mockClear();
  try {
    const saving = view.sender().answer({ id: "ask-1", runId: "run-1" } as never, "yes");
    navigation.focused = false;
    accept();
    await saving;
    expect(hapticSuccess).not.toHaveBeenCalled();
    navigation.focused = true;
    await view.sender().answer({ id: "ask-2", runId: "run-1" } as never, "yes");
    expect(hapticSuccess).toHaveBeenCalledOnce();
  } finally {
    navigation.focused = true;
    await act(async () => view.root.unmount());
  }
});

it("sends a page's reply about that page: its card here, else a link, over an earlier pick", async () => {
  // Two pages in the chat; the older one's reply answers its own card, not the newest page.
  const twoPages = await chat([card("m1", "p-old"), card("m2", "p-new"), said("m3", "hi")]);
  await twoPages.tapOnPage("p-old", "Old plan", "Use option B");
  expect(await twoPages.sent()).toMatchObject({
    botId: "bot-1",
    text: "Use option B",
    replyToMessageId: "m1",
    fromPage: true,
    replyQuote: undefined,
  });

  // A message picked to reply to before the page opened gives way to the page.
  await act(async () => twoPages.sender().setReplyTarget(said("m3", "hi") as never));
  await twoPages.tapOnPage("p-new", "New plan", "Ship it");
  expect(await twoPages.sent()).toMatchObject({ replyToMessageId: "m2", fromPage: true });
  await act(async () => twoPages.root.unmount());

  // The page's card isn't loaded here: the message names the page instead.
  const noCard = await chat([said("m3", "hi")]);
  await act(async () => noCard.sender().setReplyTarget(said("m3", "hi") as never));
  await noCard.tapOnPage("p-old", "Q3 [draft]", "Use option B");
  const linked = await noCard.sent();
  expect(linked).toMatchObject({ text: "[Q3 \\[draft\\]](page:p-old)\nUse option B" });
  expect([linked?.replyToMessageId, linked?.fromPage]).toEqual([undefined, undefined]);

  // Once sent, the next message is the user's own again.
  await act(async () => noCard.sender().composerRef.current?.addReply("just text"));
  expect(await noCard.sent()).toMatchObject({ text: "just text", fromPage: undefined });
  await act(async () => noCard.root.unmount());
});

it("keeps a reply the user picks after the page's reply lands", async () => {
  const picked = await chat([card("m1", "p-old"), said("m3", "hi")]);
  await picked.tapOnPage("p-old", "Old plan", "Use option B");
  await act(async () => picked.sender().setReplyTarget(said("m3", "hi") as never));
  expect(await picked.sent()).toMatchObject({
    replyToMessageId: "m3",
    text: "Use option B",
    fromPage: undefined,
  });
  await act(async () => picked.root.unmount());
});

it("forgets the page once the user clears its reply from the composer", async () => {
  const cleared = await chat([card("m1", "p-old"), said("m3", "hi")]);
  await cleared.tapOnPage("p-old", "Old plan", "Use option B");
  await act(async () => {
    cleared.sender().composerRef.current?.reset();
    cleared.sender().composerEmptied();
    cleared.sender().composerRef.current?.addReply("something else");
  });
  const sent = await cleared.sent();
  expect(sent).toMatchObject({ text: "something else" });
  expect([sent?.replyToMessageId, sent?.fromPage]).toEqual([undefined, undefined]);

  // Typed after the page's reply, not instead of it, the message still answers the page.
  await cleared.tapOnPage("p-old", "Old plan", "Use option B");
  await act(async () => cleared.sender().composerRef.current?.addReply("now"));
  expect(await cleared.sent()).toMatchObject({ replyToMessageId: "m1", fromPage: true });
  await act(async () => cleared.root.unmount());
});
