// @vitest-environment jsdom
import type { Bot, ComputerStatus, Me, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { composerHoldsUnsavedWork, writeComposerDraft } from "../../lib/composer-draft";
import type { PageSession } from "../../lib/pages";
import { createPageSession } from "../../lib/pages";
import type { createSpaceRpc } from "../../lib/rpc";
import { useComposerActions } from "./use-composer-actions";

vi.mock("@lingui/react/macro", () => {
  // One t per module, like the real catalog: a new t per render would recreate
  // every callback and hide stale-closure bugs.
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }) };
});
vi.mock("../../lib/prepare-image", () => ({
  canPrepareImage: () => false,
  prepareImage: async (file: File) => file,
}));

type Rpc = {
  routines: { testRun: ReturnType<typeof vi.fn> };
  artifacts: { create: ReturnType<typeof vi.fn> };
  threads: { send: ReturnType<typeof vi.fn>; sendWithRoutines: ReturnType<typeof vi.fn> };
};

let rpc: Rpc;
let me: Me | null;
let navigate: ReturnType<typeof vi.fn>;
let root: Root;
let latest: ReturnType<typeof useComposerActions>;
let pageSession: PageSession;
let activeChat: string;
let refreshThread: (id: string) => Promise<ThreadSnapshot>;
let activeSnapshot: ThreadSnapshot | null;
// One stable ref object per value, like the real Shell: a fresh object per
// render would leave stale closures reading the previous chat. The same goes
// for the plain functions; a fresh arrow per render would recreate callbacks.
const activeBotId = ref<string | undefined>(undefined);
const activeGroupId = ref<string | undefined>(undefined);
const botsRef = ref<Bot[]>([]);
const terminalRunReceipts = ref(new Set<string>());
const computerRef = ref<ComputerStatus | null>(null);
const refreshBots = async () => undefined;
const updateSnapshot = () => undefined;
const commitComputer = () => undefined;
const clearReadBoundary = () => undefined;
const flushPendingBrowserNotifications = () => undefined;
const refreshThreadRef = ref((id: string) => refreshThread(id));

function ref<T>(current: T) {
  return { current };
}

function Harness({
  extras,
  useActions = useComposerActions,
}: {
  extras?: Record<string, unknown>;
  useActions?: typeof useComposerActions;
}) {
  latest = useActions({
    userId: "user-1",
    currentSpaceId: "selected-space",
    ...extras,
    rpc: rpc as unknown as ReturnType<typeof createSpaceRpc>,
    pageSession,
    activeId: activeChat,
    inGroup: false,
    groupId: undefined,
    activeBotId,
    activeGroupId,
    botsRef,
    bootstrapMe: me,
    activeSnapshot,
    navigate: navigate as never,
    refreshBots,
    refreshThreadRef,
    refreshGroupThreadRef: ref(async () => ({}) as ThreadSnapshot),
    updateSnapshot,
    terminalRunReceipts,
    computerRef,
    commitComputer,
    clearReadBoundary,
    flushPendingBrowserNotifications,
  } as Parameters<typeof useComposerActions>[0]);
  return null;
}

function switchChat(activeId: string) {
  activeChat = activeId;
  activeBotId.current = activeId;
  act(() => root.render(<Harness />));
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  me = null;
  navigate = vi.fn();
  activeChat = "bot-1";
  refreshThread = async () => ({}) as ThreadSnapshot;
  activeSnapshot = null;
  activeBotId.current = activeChat;
  activeGroupId.current = undefined;
  botsRef.current = [];
  terminalRunReceipts.current = new Set();
  computerRef.current = null;
  pageSession = createPageSession();
  rpc = {
    routines: { testRun: vi.fn() },
    artifacts: { create: vi.fn() },
    threads: { send: vi.fn(), sendWithRoutines: vi.fn() },
  };
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  localStorage.clear();
});

it.each(["skill", "binding", "reply", "attachment", "page"])(
  "starts fresh intent only when changed %s is submitted",
  async (change) => {
    const text = change === "binding" ? "@Bob notes" : "notes";
    writeComposerDraft("bot:bot-1", text);
    rpc.threads.send.mockRejectedValue(new Error("answer lost"));
    await act(async () => void (await latest.sendMessage(text, [], "original")));
    const original = rpc.threads.send.mock.calls[0]![0];
    if (change === "reply") {
      act(() => latest.setReplyTarget(replyCandidate("new-reply")));
      act(() => latest.clearReply());
    } else if (change === "attachment") {
      act(() => latest.onAttachmentPick([new File(["a"], "a.txt", { type: "text/plain" })]));
      act(() => latest.removeAttachment(latest.activePendingAttachments[0]!));
    } else if (change === "page") {
      act(() => pageSession.dock.set({ page: { id: "new-page", title: "New page" } }));
      act(() => pageSession.dock.set({ page: null }));
    }
    // Selection/cancel has not replaced the operation, even with a new UI token.
    await act(async () => void (await latest.sendMessage(text, [], "another-click")));
    expect(rpc.threads.send).toHaveBeenLastCalledWith(original);
    if (change === "skill" || change === "binding") {
      writeComposerDraft(
        "bot:bot-1",
        text,
        undefined,
        change === "binding"
          ? [{ start: 0, end: 4, mention: { kind: "bot", id: "bob-new", name: "Bob" } }]
          : [],
        change === "skill"
          ? {
              id: "skill-new",
              name: "summarize",
              description: "",
              source: "user",
              readOnly: false,
            }
          : null,
      );
    } else if (change === "reply") act(() => latest.setReplyTarget(replyCandidate("new-reply")));
    else if (change === "attachment") {
      rpc.artifacts.create.mockResolvedValue({ id: "artifact-new" });
      act(() => latest.onAttachmentPick([new File(["a"], "a.txt", { type: "text/plain" })]));
    } else act(() => pageSession.dock.set({ page: { id: "new-page", title: "New page" } }));
    await act(
      async () =>
        void (await latest.sendMessage(
          text,
          change === "binding" ? [{ kind: "bot", id: "bob-new", name: "Bob" }] : [],
          "new-intent",
        )),
    );
    expect(rpc.threads.send.mock.calls.at(-1)![0].clientNonce).not.toBe(original.clientNonce);
  },
);

it.each(["@digest", "/summarize", "/summarize\nnotes"])(
  "stores and directly replays exact routine/skill request: %s",
  async (text) => {
    writeComposerDraft("bot:bot-1", text);
    const routines = text === "@digest";
    const dispatch = routines ? rpc.threads.sendWithRoutines : rpc.threads.send;
    dispatch.mockRejectedValue(new Error("lost"));
    await act(
      async () => void (await latest.sendMessage(text, routines ? [digest] : [], "original")),
    );
    const original = dispatch.mock.calls[0]![0];
    act(() => root.unmount());
    root = createRoot(document.createElement("div"));
    act(() => root.render(<Harness />));
    dispatch.mockResolvedValue(routines ? { routineRunIds: [] } : { runId: "r", taskId: "t" });
    await act(
      async () => void (await latest.sendMessage(text, routines ? [digest] : [], "new-click")),
    );
    expect(dispatch).toHaveBeenLastCalledWith(original);
    expect(rpc.artifacts.create).not.toHaveBeenCalled();
    expect(latest.sentCount).toBe(1);
  },
);

it.each([undefined, 1, 8])(
  "uses the server attachment count with a fallback (%s)",
  (maxAttachmentsPerMessage) => {
    me = { maxAttachmentsPerMessage } as Me;
    act(() => root.render(<Harness />));
    const files = Array.from(
      { length: 9 },
      (_, i) => new File(["a"], `${i}.txt`, { type: "text/plain" }),
    );
    act(() => {
      latest.onAttachmentPick(files);
    });
    const limit = maxAttachmentsPerMessage ?? 4;
    expect(latest.activePendingAttachments).toHaveLength(limit);
    expect(latest.attachmentNotice).toContain(`max ${limit} attachments`);
  },
);

it.each([false, true])(
  "replays the saved final request after a fresh owner lifetime (routines: %s)",
  async (routines) => {
    writeComposerDraft("bot:bot-1", routines ? "@digest notes" : "notes");
    pageSession.dock.set({ page: { id: "p1", title: "Original page" } });
    rpc.artifacts.create.mockResolvedValue({ id: "uploaded-original" });
    act(() => void latest.onAttachmentPick([new File(["a"], "a.txt", { type: "text/plain" })]));
    const dispatch = routines ? rpc.threads.sendWithRoutines : rpc.threads.send;
    dispatch.mockImplementation(() => {
      expect(Object.values(localStorage).some((value) => value.includes("uploaded-original"))).toBe(
        true,
      );
      return new Promise(() => {}); // The document disappears before the answer settles.
    });
    act(
      () =>
        void latest.sendMessage(
          routines ? "@digest notes" : "notes",
          routines ? [digest] : [],
          "original-operation",
        ),
    );
    await flush();
    const original = dispatch.mock.calls[0]![0];
    act(() => root.unmount());
    vi.resetModules();
    const fresh = await import("./use-composer-actions");
    pageSession = createPageSession();
    root = createRoot(document.createElement("div"));
    function Fresh() {
      latest = fresh.useComposerActions({
        userId: "user-1",
        currentSpaceId: "selected-space",
        rpc: rpc as unknown as ReturnType<typeof createSpaceRpc>,
        pageSession,
        activeId: activeChat,
        inGroup: false,
        groupId: undefined,
        activeBotId,
        activeGroupId,
        botsRef,
        bootstrapMe: me,
        activeSnapshot,
        navigate: navigate as never,
        refreshBots,
        refreshThreadRef,
        refreshGroupThreadRef: refreshThreadRef,
        updateSnapshot,
        terminalRunReceipts,
        computerRef,
        commitComputer,
        clearReadBoundary,
        flushPendingBrowserNotifications,
      });
      return null;
    }
    act(() => root.render(<Fresh />));
    dispatch.mockResolvedValue(routines ? { send: null, routineRunIds: [] } : null);
    await act(
      async () =>
        void (await latest.sendMessage(
          routines ? "@digest notes" : "notes",
          routines ? [digest] : [],
          "new-click",
        )),
    );
    expect(dispatch).toHaveBeenLastCalledWith(original);
    expect(rpc.artifacts.create).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true].flatMap((routines) => [false, true].map((reply) => ({ routines, reply }))))(
  "preserves a final image confirmation as a durable file derivative ($routines, $reply)",
  async ({ routines, reply }) => {
    const text = `${routines ? "@digest " : ""}@Bob notes`;
    const bob = { kind: "bot" as const, id: "bob", name: "Bob" };
    const mentions = routines ? [digest, bob] : [bob];
    writeComposerDraft("bot:bot-1", text);
    pageSession.dock.set({ page: { id: "p1", title: "Original page" } });
    if (reply) {
      act(() => {
        latest.setReplyTarget(replyCandidate("original-reply"));
        latest.setReplyQuote("original excerpt");
      });
    }
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    rpc.artifacts.create.mockResolvedValue({ id: "uploaded-image" });
    act(() => latest.onAttachmentPick([new File(["image"], "photo.png", { type: "image/png" })]));
    const dispatch = routines ? rpc.threads.sendWithRoutines : rpc.threads.send;
    const confirmation = { status: 409, data: { reason: "model_image_input_unsupported" } };
    dispatch.mockRejectedValue(confirmation);
    await act(async () => {
      expect(await latest.sendMessage(text, mentions, "original-image")).toBe(false);
    });
    expect(latest.imageConfirmation).toBe(true);
    const original = dispatch.mock.calls[0]![0];
    const originalCopy = structuredClone(original);
    expect(original).toMatchObject({
      botId: "bot-1",
      artifactIds: ["uploaded-image"],
      imageHandling: "confirm",
      replyToMessageId: reply ? "original-reply" : undefined,
      replyQuote: reply ? "original excerpt" : undefined,
      mentions: [{ kind: "bot", id: "bob" }],
    });
    if (!reply) expect(original.text).toContain("[Original page](page:p1)");
    if (routines) expect(original.routineIds).toEqual([digest.id]);
    const storageKey = "rakazo.composerSend.bot:bot-1";
    const saved = JSON.parse(localStorage.getItem(storageKey)!);
    const remount = async () => {
      act(() => root.unmount());
      vi.resetModules();
      const fresh = await import("./use-composer-actions");
      pageSession = createPageSession();
      root = createRoot(document.createElement("div"));
      act(() => root.render(<Harness useActions={fresh.useComposerActions} />));
      expect(latest.activePendingAttachments).toEqual([]);
      expect(latest.replyTarget).toBeNull();
    };
    await remount();
    await act(async () => {
      expect(await latest.sendMessage(text, [], "normal-replay")).toBe(false);
    });
    expect(dispatch).toHaveBeenLastCalledWith(originalCopy);
    expect(latest.imageConfirmation).toBe(true);
    const persistedAtDispatch: unknown[] = [];
    dispatch.mockImplementation(async () => {
      // The derivative's identity and original context must be durable before dispatch.
      persistedAtDispatch.push(JSON.parse(localStorage.getItem(storageKey)!));
      throw new Error("answer lost");
    });
    await act(async () => void (await latest.sendMessage(text, [], "file-click", "file")));
    const derivative = dispatch.mock.calls.at(-1)![0];
    expect(derivative.clientNonce).not.toBe(originalCopy.clientNonce);
    expect(derivative).toEqual({
      ...originalCopy,
      imageHandling: "file",
      clientNonce: derivative.clientNonce,
    });
    expect(persistedAtDispatch).toEqual([
      { ...saved, envelope: { ...saved.envelope, body: derivative } },
    ]);
    expect(original).toEqual(originalCopy);
    await act(async () => void (await latest.sendMessage(text, [], "file-retry", "file")));
    expect(dispatch).toHaveBeenLastCalledWith(derivative);
    await remount();
    dispatch.mockResolvedValue(routines ? { send: null, routineRunIds: [] } : null);
    await act(async () => {
      expect(await latest.sendMessage(text, [], "after-reload", "file")).toBe(true);
    });
    expect(dispatch).toHaveBeenLastCalledWith(derivative);
    expect(rpc.artifacts.create).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(storageKey)).toBeNull();
    vi.restoreAllMocks();
  },
);

it("removes only the picked attachment when name, size and date match another", () => {
  // Two picks of equal metadata used to derive the same id, so removing one dropped both.
  const fileA = new File(["a"], "a.txt", { type: "text/plain", lastModified: 100 });
  const fileB = new File(["b"], "a.txt", { type: "text/plain", lastModified: 100 });
  act(() => void latest.onAttachmentPick([fileA]));
  act(() => void latest.onAttachmentPick([fileB]));
  const first = latest.activePendingAttachments[0]!;
  const second = latest.activePendingAttachments[1]!;
  expect(first.id).not.toBe(second.id);
  act(() => latest.removeAttachment(first));
  expect(latest.activePendingAttachments).toEqual([second]);
});

it("keeps an attachment added while a send is in flight", async () => {
  const fileA = new File(["a"], "a.txt", { type: "text/plain" });
  const fileB = new File(["b"], "b.txt", { type: "text/plain" });
  rpc.artifacts.create.mockImplementation(async ({ name }: { name: string }) => ({
    id: `artifact-${name}`,
  }));
  let finishSend!: () => void;
  rpc.threads.send.mockReturnValue(
    new Promise((resolve) => {
      finishSend = () => resolve({ runId: "run-1", taskId: "task-1" });
    }),
  );
  act(() => void latest.onAttachmentPick([fileA]));

  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("", [], "nonce-1");
  });
  await flush();
  act(() => void latest.onAttachmentPick([fileB]));
  finishSend();
  await act(async () => void (await sent));

  expect(rpc.threads.send).toHaveBeenCalledWith(
    expect.objectContaining({ artifactIds: ["artifact-a.txt"] }),
  );
  expect(latest.activePendingAttachments.map((pending) => pending.file)).toEqual([fileB]);
});

it("discards a deleted chat's attachments with their previews and unsaved-work flag", () => {
  const file = new File(["a"], "photo.png", { type: "image/png" });
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview-a");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  try {
    act(() => void latest.onAttachmentPick([file]));
    expect(composerHoldsUnsavedWork()).toBe(true);
    act(() => latest.discardThreadAttachments("bot-1"));
    expect(latest.activePendingAttachments).toEqual([]);
    expect(revoke).toHaveBeenCalledWith("blob:preview-a");
    expect(composerHoldsUnsavedWork()).toBe(false);
  } finally {
    create.mockRestore();
    revoke.mockRestore();
  }
});

it("keeps an attachment and its preview when the chat is archived and restored", () => {
  const file = new File(["a"], "photo.png", { type: "image/png" });
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview-a");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  try {
    act(() => void latest.onAttachmentPick([file]));
    // Archiving drops the chat from the active roster and restore brings the
    // same id back. The roster-driven cleanup used to discard the file here;
    // only a confirmed deletion may.
    act(() => root.render(<Harness extras={{ rosterChatIds: new Set() }} />));
    switchChat("bot-2");
    switchChat("bot-1");
    const restored = latest.activePendingAttachments;
    expect(restored.map((pending) => pending.file)).toEqual([file]);
    expect(restored[0]!.previewUrl).toBe("blob:preview-a");
    expect(revoke).not.toHaveBeenCalled();
    expect(composerHoldsUnsavedWork()).toBe(true);
  } finally {
    create.mockRestore();
    revoke.mockRestore();
  }
});

it("keeps unsent attachments when switching chats and back", () => {
  const file = new File(["a"], "photo.png", { type: "image/png" });
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview-a");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  try {
    act(() => void latest.onAttachmentPick([file]));
    const preview = latest.activePendingAttachments[0]!.previewUrl;
    expect(preview).toBe("blob:preview-a");
    switchChat("bot-2");
    expect(latest.activePendingAttachments).toEqual([]);
    switchChat("bot-1");
    const restored = latest.activePendingAttachments;
    expect(restored.map((pending) => pending.file)).toEqual([file]);
    expect(restored[0]!.previewUrl).toBe("blob:preview-a");
    expect(revoke).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
    revoke.mockRestore();
  }
});

it("does not send another chat's attachments from the open chat", async () => {
  const file = new File(["a"], "a.txt", { type: "text/plain" });
  act(() => void latest.onAttachmentPick([file]));
  switchChat("bot-2");
  rpc.threads.send.mockResolvedValue({ runId: "run-1", taskId: "task-1" });
  await act(async () => {
    await latest.sendMessage("hello", [], "nonce-2");
  });
  expect(rpc.artifacts.create).not.toHaveBeenCalled();
  expect(rpc.threads.send).toHaveBeenCalledWith(
    expect.objectContaining({ text: "hello", artifactIds: undefined }),
  );
  switchChat("bot-1");
  expect(latest.activePendingAttachments.map((pending) => pending.file)).toEqual([file]);
});

const digest = { kind: "routine" as const, id: "routine-1", name: "digest" };
const review = { kind: "routine" as const, id: "routine-2", name: "review" };

async function send(text: string, mentions: (typeof digest)[]) {
  let accepted!: boolean;
  await act(async () => {
    accepted = await latest.sendMessage(text, mentions, "nonce-1");
  });
  return accepted;
}

it("sends text and routines as one request and gives the draft back when it fails", async () => {
  // Before, the routines ran on their own first, so a failed text send could not be retried.
  rpc.routines.testRun.mockResolvedValue({ runId: "routine-run" });
  rpc.threads.send.mockRejectedValue(new Error("offline"));
  rpc.threads.sendWithRoutines.mockRejectedValue(new Error("offline"));

  expect(await send("@digest @review and the notes", [digest, review])).toBe(false);

  expect(rpc.routines.testRun).not.toHaveBeenCalled();
  expect(rpc.threads.send).not.toHaveBeenCalled();
  expect(rpc.threads.sendWithRoutines).toHaveBeenCalledTimes(1);
  expect(rpc.threads.sendWithRoutines).toHaveBeenCalledWith(
    expect.objectContaining({
      botId: "bot-1",
      clientNonce: "nonce-1",
      routineIds: ["routine-1", "routine-2"],
      text: expect.stringContaining("and the notes"),
    }),
  );
});

it("clears the draft once the send with routines is accepted", async () => {
  rpc.threads.sendWithRoutines.mockResolvedValue({
    routineRunIds: ["routine-run"],
    send: { runId: "run-1", taskId: "task-1", seq: 1 },
  });

  expect(await send("@digest and the notes", [digest])).toBe(true);
  expect(rpc.threads.sendWithRoutines).toHaveBeenCalledTimes(1);
});

it("runs routines without text in one request", async () => {
  rpc.routines.testRun.mockImplementation(async ({ routineId }: { routineId: string }) => {
    if (routineId === review.id) throw new Error("offline");
    return { runId: "routine-run" };
  });
  rpc.threads.sendWithRoutines.mockRejectedValueOnce(new Error("offline"));

  expect(await send("@digest @review", [digest, review])).toBe(false);
  expect(rpc.routines.testRun).not.toHaveBeenCalled();
  expect(rpc.threads.sendWithRoutines).toHaveBeenCalledWith({
    botId: "bot-1",
    clientNonce: "nonce-1",
    routineIds: ["routine-1", "routine-2"],
  });

  rpc.threads.sendWithRoutines.mockResolvedValueOnce({ routineRunIds: ["a", "b"] });
  expect(await send("@digest @review", [digest, review])).toBe(true);
  expect(rpc.threads.send).not.toHaveBeenCalled();
});

it("counts a routines-only send as sent when its follow-up refresh fails", async () => {
  rpc.threads.sendWithRoutines.mockResolvedValue({ routineRunIds: ["routine-run"] });
  // The routine is already running; only the thread read that follows the send fails.
  refreshThread = () => Promise.reject(new TypeError("Failed to fetch"));

  expect(await send("@digest", [digest])).toBe(true);

  expect(latest.sendError).toBeNull();
});

it("opens a mentioned group without running anything", async () => {
  const team = { kind: "group" as const, id: "group-2", name: "Team" };
  let accepted!: boolean;
  await act(async () => {
    accepted = await latest.sendMessage("@Team", [team], "nonce-1");
  });

  expect(accepted).toBe(true);
  expect(navigate).toHaveBeenCalledWith("/app/g/group-2");
  expect(rpc.threads.sendWithRoutines).not.toHaveBeenCalled();
  expect(rpc.threads.send).not.toHaveBeenCalled();
});

it("asks the chat to follow on submit, before the send lands", async () => {
  let finishSend!: () => void;
  rpc.threads.send.mockReturnValue(
    new Promise((resolve) => {
      finishSend = () => resolve({ runId: "run-1", taskId: "task-1" });
    }),
  );
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("hello", [], "nonce-1");
  });
  expect(latest.sentCount).toBe(1);
  finishSend();
  await act(async () => void (await sent));
  expect(latest.sentCount).toBe(1);

  rpc.threads.sendWithRoutines.mockResolvedValue({ routineRunIds: ["routine-run"] });
  expect(await send("@digest", [digest])).toBe(true);
  expect(rpc.threads.sendWithRoutines).toHaveBeenCalledWith(
    expect.not.objectContaining({ text: expect.anything() }),
  );
  expect(latest.sentCount).toBe(2);
});

it("names the open page only on text the chat itself sends", async () => {
  pageSession.dock.set({ page: { id: "p1", title: "Sales" } });
  const team = { kind: "group" as const, id: "group-2", name: "Team" };
  rpc.threads.sendWithRoutines.mockResolvedValue({ routineRunIds: ["routine-run"] });
  rpc.threads.send.mockResolvedValue(null);

  expect(await send("@digest", [digest])).toBe(true);
  expect(rpc.threads.sendWithRoutines).toHaveBeenLastCalledWith({
    botId: "bot-1",
    clientNonce: "nonce-1",
    routineIds: ["routine-1"],
  });
  await act(async () => void (await latest.sendMessage("@Team", [team], "nonce-2")));
  expect(navigate).toHaveBeenLastCalledWith("/app/g/group-2");
  expect(rpc.threads.send).not.toHaveBeenCalled();

  await act(async () => void (await latest.sendMessage("@Team hi all", [team], "nonce-3")));
  expect(rpc.threads.send).toHaveBeenLastCalledWith(
    expect.objectContaining({ groupId: "group-2", text: "hi all" }),
  );

  await send("bigger", []);
  expect(rpc.threads.send).toHaveBeenLastCalledWith(
    expect.objectContaining({ botId: "bot-1", text: "[Sales](page:p1)\nbigger" }),
  );
  await send("@digest and notes", [digest]);
  expect(rpc.threads.sendWithRoutines).toHaveBeenLastCalledWith(
    expect.objectContaining({ botId: "bot-1", text: "[Sales](page:p1)\nand notes" }),
  );
});

it("reuses an attachment's upload nonce across send retries", async () => {
  const file = new File(["a"], "a.txt", { type: "text/plain" });
  rpc.artifacts.create.mockResolvedValue({ id: "artifact-1" });
  rpc.threads.send.mockRejectedValueOnce(new Error("offline"));
  act(() => void latest.onAttachmentPick([file]));

  await act(async () => void (await latest.sendMessage("hello", [], "nonce-1")));
  // The failed send keeps its attachment; an edited draft retries under a new
  // send nonce and must still reach the artifact the first upload created.
  expect(await latest.sendMessage("hello again", [], "nonce-2")).toBe(true);

  expect(rpc.artifacts.create).toHaveBeenCalledTimes(2);
  const firstCall = rpc.artifacts.create.mock.calls[0]![0] as { clientNonce?: string };
  const retryCall = rpc.artifacts.create.mock.calls[1]![0] as { clientNonce?: string };
  expect(firstCall.clientNonce).toBe(retryCall.clientNonce);
  expect(firstCall.clientNonce).toContain("bot-1");
  expect(rpc.threads.send).toHaveBeenLastCalledWith(
    expect.objectContaining({ artifactIds: ["artifact-1"] }),
  );
});

function replyCandidate(id: string): ThreadMessage {
  return { id, role: "user", blocks: [] } as unknown as ThreadMessage;
}

it("keeps a reply picked while an older message send is in flight", async () => {
  act(() => latest.setReplyTarget(replyCandidate("m-1")));
  let finishSend!: () => void;
  rpc.threads.send.mockReturnValue(
    new Promise((resolve) => {
      finishSend = () => resolve({ runId: "run-1", taskId: "task-1" });
    }),
  );
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("hello", [], "nonce-1");
  });
  await flush();
  const pickedMeanwhile = replyCandidate("m-2");
  act(() => {
    latest.setReplyTarget(pickedMeanwhile);
    latest.setReplyQuote("picked while sending");
  });

  finishSend();
  await act(async () => void (await sent));

  expect(rpc.threads.send).toHaveBeenCalledWith(
    expect.objectContaining({ replyToMessageId: "m-1" }),
  );
  expect(latest.replyTarget).toBe(pickedMeanwhile);
});

it("keeps a reply picked while a routines-only send is in flight", async () => {
  act(() => latest.setReplyTarget(replyCandidate("m-1")));
  let finishSend!: () => void;
  rpc.threads.sendWithRoutines.mockReturnValue(
    new Promise((resolve) => {
      finishSend = () => resolve({ routineRunIds: ["routine-run"] });
    }),
  );
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("@digest", [digest], "nonce-1");
  });
  await flush();
  const pickedMeanwhile = replyCandidate("m-2");
  act(() => latest.setReplyTarget(pickedMeanwhile));

  finishSend();
  await act(async () => void (await sent));

  expect(latest.replyTarget).toBe(pickedMeanwhile);
});

it("clears the reply a finished send used when no newer one was picked", async () => {
  act(() => latest.setReplyTarget(replyCandidate("m-1")));
  rpc.threads.send.mockResolvedValue({ runId: "run-1", taskId: "task-1" });

  await act(async () => void (await latest.sendMessage("hello", [], "nonce-1")));

  expect(latest.replyTarget).toBeNull();
});

it("keeps a newer excerpt of the same message picked while its older send is in flight", async () => {
  const message = replyCandidate("m-1");
  act(() => {
    latest.setReplyTarget(message);
    latest.setReplyQuote("first excerpt");
  });
  let finishSend!: () => void;
  rpc.threads.send.mockReturnValue(
    new Promise((resolve) => {
      finishSend = () => resolve({ runId: "run-1", taskId: "task-1" });
    }),
  );
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("hello", [], "nonce-1");
  });
  await flush();
  // Re-arming the same message object with a different excerpt must read as
  // a newer pick, not as the reply the in-flight send still holds.
  act(() => {
    latest.setReplyTarget(message);
    latest.setReplyQuote("second excerpt");
  });

  finishSend();
  await act(async () => void (await sent));

  expect(latest.replyTarget).toBe(message);
  expect(latest.replyQuote).toBe("second excerpt");
});

it("clears a reply re-picked as a fresh object after a thread refresh", async () => {
  act(() => latest.setReplyTarget(replyCandidate("m-1")));
  // A thread refresh replaces the message objects; picking the same message
  // again arms a fresh object with the same id and quote.
  activeSnapshot = { messages: [replyCandidate("m-1")] } as ThreadSnapshot;
  act(() => root.render(<Harness />));
  act(() => latest.setReplyTarget(replyCandidate("m-1")));
  rpc.threads.send.mockResolvedValue({ runId: "run-1", taskId: "task-1" });

  await act(async () => void (await latest.sendMessage("hello", [], "nonce-1")));

  expect(rpc.threads.send).toHaveBeenCalledWith(
    expect.objectContaining({ replyToMessageId: "m-1" }),
  );
  expect(latest.replyTarget).toBeNull();
});

it("clears a quoted reply re-picked as a fresh object after a thread refresh", async () => {
  act(() => {
    latest.setReplyTarget(replyCandidate("m-1"));
    latest.setReplyQuote("same excerpt");
  });
  activeSnapshot = { messages: [replyCandidate("m-1")] } as ThreadSnapshot;
  act(() => root.render(<Harness />));
  act(() => {
    latest.setReplyTarget(replyCandidate("m-1"));
    latest.setReplyQuote("same excerpt");
  });
  rpc.threads.send.mockResolvedValue({ runId: "run-1", taskId: "task-1" });

  await act(async () => void (await latest.sendMessage("hello", [], "nonce-1")));

  expect(rpc.threads.send).toHaveBeenCalledWith(
    expect.objectContaining({ replyToMessageId: "m-1", replyQuote: "same excerpt" }),
  );
  expect(latest.replyTarget).toBeNull();
  expect(latest.replyQuote).toBeNull();
});
