// @vitest-environment jsdom

import type { Bot, ComputerStatus, Me, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { THREAD_MESSAGE_TEXT_MAX_LENGTH } from "@rakazo/contracts";
import { deferred, flush as flushTimer } from "@rakazo/core/test-async";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  appendComposerDraftText,
  beginComposerDraftSubmission,
  clearComposerDrafts,
  composerDraftKey,
  composerHoldsUnsavedWork,
  readComposerDraft,
  readComposerDraftBindings,
  settleComposerDraftSubmission,
  subscribeComposerDraftAccepted,
  subscribeComposerDraftReplaced,
  writeComposerDraft,
} from "../../../lib/composer/composer-draft";
import type { PageSession } from "../../../lib/pages/pages";
import { createPageSession } from "../../../lib/pages/pages";
import { createQueryRoot } from "../../../lib/query/query-root.test-support";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import { useComposerActions } from "./use-composer-actions";

vi.mock("@lingui/react/macro", () => {
  // One t per module, like the real catalog: a new t per render would recreate
  // every callback and hide stale-closure bugs.
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t, i18n: { locale: "en" } }) };
});
vi.mock("../../../lib/query/rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/query/rpc")>()),
  rpcForSpace: () => rpc,
  createSpaceRpc: () => rpc,
}));
vi.mock("../../../lib/composer/prepare-image", () => ({
  canPrepareImage: () => false,
  prepareImage: async (file: File) => file,
}));

type Rpc = {
  routines: { testRun: ReturnType<typeof vi.fn> };
  artifacts: { create: ReturnType<typeof vi.fn> };
  threads: {
    get: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    sendWithRoutines: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
};

let rpc: Rpc;
let me: Me | null;
let navigate: ReturnType<typeof vi.fn>;
let root: ReturnType<typeof createQueryRoot>;
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

function Harness({ extras }: { extras?: Record<string, unknown> }) {
  latest = useComposerActions({
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
    for (let i = 0; i < 20; i++) await flushTimer();
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
    threads: { get: vi.fn(), send: vi.fn(), sendWithRoutines: vi.fn(), retry: vi.fn() },
  };
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  clearComposerDrafts();
  localStorage.clear();
});

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

it("previews only the images a browser shows inline", () => {
  const photo = new File(["a"], "photo.png", { type: "image/png" });
  const heic = new File(["a"], "IMG_0001.heic", { type: "image/heic" });
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview-a");
  try {
    act(() => void latest.onAttachmentPick([photo, heic]));
    expect(latest.activePendingAttachments.map((pending) => pending.previewUrl)).toEqual([
      "blob:preview-a",
      undefined,
    ]);
    expect(create).toHaveBeenCalledOnce();
  } finally {
    create.mockRestore();
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

function failedReply(runId: string): ThreadSnapshot {
  return {
    run: {
      id: runId,
      status: "failed",
      trigger: "user",
      userId: "user-1",
      error: "terminated",
      retryable: true,
    },
  } as ThreadSnapshot;
}

function pendingRetry() {
  const retry = deferred<{ runId: string }>();
  rpc.threads.retry.mockReturnValue(retry.promise);
  return retry.reject;
}

it("offers no retry anywhere while one is in flight, then offers another chat's", async () => {
  me = { userId: "user-1" } as Me;
  activeSnapshot = failedReply("run-1");
  act(() => root.render(<Harness />));
  const reject = pendingRetry();
  act(() => void latest.retryRun?.());
  expect(latest.retryRun).toBeUndefined();

  activeSnapshot = failedReply("run-2");
  switchChat("bot-2");
  expect(latest.retryRun).toBeUndefined();
  reject(new Error("Conflict"));
  await flush();
  expect(latest.retryRun).toBeDefined();
  rpc.threads.retry.mockResolvedValue({ runId: "run-3" });
  act(() => void latest.retryRun?.());
  expect(rpc.threads.retry).toHaveBeenLastCalledWith({ botId: "bot-2", runId: "run-2" });
});

it("drops a late retry error once a newer failure is on screen", async () => {
  me = { userId: "user-1" } as Me;
  activeSnapshot = failedReply("run-1");
  act(() => root.render(<Harness />));
  const reject = pendingRetry();
  act(() => void latest.retryRun?.());

  activeSnapshot = failedReply("run-2");
  act(() => root.render(<Harness />));
  reject(new Error("Conflict"));
  await flush();
  expect(latest.sendError).toBeNull();
  expect(latest.displayedRunErrorId).toBe("run-2");
});

it("shows a retry error for the failure still on screen", async () => {
  me = { userId: "user-1" } as Me;
  activeSnapshot = failedReply("run-1");
  act(() => root.render(<Harness />));
  const reject = pendingRetry();
  act(() => void latest.retryRun?.());
  reject(new Error("Conflict"));
  await flush();
  expect(latest.sendError).toBeTruthy();
  expect(latest.retryRun).toBeUndefined();
});

it("holds the retry while a new message is sending", async () => {
  me = { userId: "user-1" } as Me;
  activeSnapshot = failedReply("run-1");
  const send = deferred<unknown>();
  rpc.threads.send.mockReturnValue(send.promise);
  act(() => root.render(<Harness />));
  expect(latest.retryRun).toBeDefined();
  act(() => void latest.sendMessage("Never mind.", [], "nonce-retry"));
  await flush();
  expect(latest.retryRun).toBeUndefined();
});

it("shows a text send at once and keeps it when the follow-up refresh fails", async () => {
  const reply = deferred<{ runId: string; taskId: string; seq: number }>();
  rpc.threads.send.mockReturnValue(reply.promise);
  activeSnapshot = { threadId: "t-1", messages: [] } as unknown as ThreadSnapshot;
  refreshThread = () => Promise.reject(new Error("offline"));
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("hello there", [], "nonce-1");
  });
  expect(latest.pendingSends).toEqual([
    { threadKey: "bot-1", clientNonce: "nonce-1", text: "hello there", afterSeq: 0 },
  ]);
  expect(latest.transcriptProps.transcript?.messages.map((message) => message.id)).toEqual([
    "pending:nonce-1",
  ]);

  reply.resolve({ runId: "run-1", taskId: "task-1", seq: 7 });
  await act(async () => void (await sent));
  await act(flushTimer);
  // Accepted but not yet in the chat: it stays until the stored message arrives.
  expect(latest.pendingSends).toEqual([
    {
      threadKey: "bot-1",
      clientNonce: "nonce-1",
      text: "hello there",
      afterSeq: 0,
      acceptedSeq: 7,
    },
  ]);
});

it("keeps every send of a quick run pending", async () => {
  rpc.threads.send
    .mockResolvedValueOnce({ runId: "run-1", taskId: "task-1", seq: 1 })
    .mockResolvedValueOnce({ runId: "run-2", taskId: "task-2", seq: 2 });
  await act(async () => void (await latest.sendMessage("first", [], "nonce-1")));
  await act(async () => void (await latest.sendMessage("second", [], "nonce-2")));
  expect(latest.pendingSends.map((pending) => [pending.text, pending.acceptedSeq])).toEqual([
    ["first", 1],
    ["second", 2],
  ]);
});

it("drops a text send that fails", async () => {
  const reply = deferred<never>();
  rpc.threads.send.mockReturnValue(reply.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("hello there", [], "nonce-1");
  });
  expect(latest.pendingSends.map((pending) => pending.text)).toEqual(["hello there"]);

  reply.reject(new Error("offline"));
  await act(async () => void (await sent));
  expect(await sent).toBe(false);
  expect(latest.pendingSends).toEqual([]);
});

it("keeps a failed text send in chat when the user kept typing and retries it with the same clientNonce", async () => {
  const reply = deferred<{ runId: string; taskId: string; seq: number }>();
  rpc.threads.send.mockReturnValueOnce(reply.promise);
  activeSnapshot = { threadId: "t-1", messages: [] } as unknown as ThreadSnapshot;
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("first draft", [], "nonce-edited");
  });
  // User starts typing a newer draft while the first send is in flight.
  act(() => {
    latest.clearImageConfirmation();
  });

  reply.reject(new Error("offline"));
  await act(async () => void (await sent));
  expect(await sent).toBe(false);
  expect(latest.pendingSends).toEqual([
    expect.objectContaining({
      threadKey: "bot-1",
      clientNonce: "nonce-edited",
      text: "first draft",
      error: expect.any(String),
    }),
  ]);
  expect(latest.transcriptProps.failedPendingSends?.get("nonce-edited")).toEqual(
    expect.any(String),
  );
  expect(latest.transcriptProps.transcript?.messages.map((message) => message.id)).toEqual([
    "pending:nonce-edited",
  ]);

  // Retry reuses the exact same clientNonce and settles once accepted.
  rpc.threads.send.mockResolvedValueOnce({ runId: "run-2", taskId: "task-2", seq: 4 });
  let retried!: boolean;
  await act(async () => {
    retried = await latest.retryPendingSend("nonce-edited");
  });
  expect(retried).toBe(true);
  expect(rpc.threads.send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      botId: "bot-1",
      clientNonce: "nonce-edited",
      text: "first draft",
    }),
  );
  expect(latest.pendingSends).toEqual([
    expect.objectContaining({
      clientNonce: "nonce-edited",
      acceptedSeq: 4,
      error: undefined,
    }),
  ]);
  expect(latest.transcriptProps.failedPendingSends).toBeUndefined();
});

it("dismisses a failed text send without sending again", async () => {
  const reply = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(reply.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("drop me", [], "nonce-dismiss");
  });
  act(() => {
    latest.clearImageConfirmation();
  });
  reply.reject(new Error("offline"));
  await act(async () => void (await sent));
  expect(latest.pendingSends).toHaveLength(1);

  act(() => {
    latest.discardPendingSend("nonce-dismiss");
  });
  expect(latest.pendingSends).toEqual([]);
  expect(latest.transcriptProps.failedPendingSends).toBeUndefined();
});

it("does not refresh an inactive chat when a retried send finishes after switching chats", async () => {
  const firstFail = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(firstFail.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("first draft", [], "nonce-switch");
  });
  act(() => latest.clearImageConfirmation());
  firstFail.reject(new Error("offline"));
  await act(async () => void (await sent));

  const retryReply = deferred<{ runId: string; taskId: string; seq: number }>();
  rpc.threads.send.mockReturnValueOnce(retryReply.promise);
  const refreshSpy = vi.fn(async () => ({}) as ThreadSnapshot);
  refreshThread = refreshSpy;
  let retried!: Promise<boolean>;
  act(() => {
    retried = latest.retryPendingSend("nonce-switch");
  });
  // User switches to bot-2 while bot-1's retry is still in flight.
  switchChat("bot-2");

  retryReply.resolve({ runId: "run-2", taskId: "task-2", seq: 4 });
  await act(async () => void (await retried));
  expect(await retried).toBe(true);
  expect(refreshSpy).not.toHaveBeenCalled();
});

it("clears the armed reply when retrying a failed reply, unless a newer reply was picked", async () => {
  const originalReply = replyCandidate("m-1");
  act(() => {
    latest.setReplyTarget(originalReply);
    latest.setReplyQuote("old quote");
  });
  const firstFail = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(firstFail.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("reply draft", [], "nonce-reply-1");
  });
  act(() => latest.clearImageConfirmation());
  firstFail.reject(new Error("offline"));
  await act(async () => void (await sent));

  rpc.threads.send.mockResolvedValueOnce({ runId: "run-2", taskId: "task-2", seq: 5 });
  await act(async () => void (await latest.retryPendingSend("nonce-reply-1")));
  expect(rpc.threads.send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      clientNonce: "nonce-reply-1",
      replyToMessageId: "m-1",
      replyQuote: "old quote",
    }),
  );
  expect(latest.replyTarget).toBeNull();
  expect(latest.replyQuote).toBeNull();

  // When a newer reply is picked before retrying, retrying the older failed send keeps it.
  act(() => latest.setReplyTarget(originalReply));
  const secondFail = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(secondFail.promise);
  act(() => {
    sent = latest.sendMessage("reply draft 2", [], "nonce-reply-2");
  });
  act(() => latest.clearImageConfirmation());
  secondFail.reject(new Error("offline"));
  await act(async () => void (await sent));

  const newerReply = replyCandidate("m-9");
  act(() => latest.setReplyTarget(newerReply));
  rpc.threads.send.mockResolvedValueOnce({ runId: "run-3", taskId: "task-3", seq: 6 });
  await act(async () => void (await latest.retryPendingSend("nonce-reply-2")));
  expect(latest.replyTarget).toBe(newerReply);
});

it("disables retry while teaching is active but still lets the user dismiss a failed row", async () => {
  const reply = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(reply.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("blocked by teach", [], "nonce-teach");
  });
  act(() => latest.clearImageConfirmation());
  reply.reject(new Error("offline"));
  await act(async () => void (await sent));

  act(() => root.render(<Harness extras={{ recordingSkill: true }} />));
  expect(latest.transcriptProps.retryingPendingSend).toBe(true);
  let retried!: boolean;
  await act(async () => {
    retried = await latest.retryPendingSend("nonce-teach");
  });
  expect(retried).toBe(false);
  expect(rpc.threads.send).toHaveBeenCalledTimes(1);

  act(() => latest.discardPendingSend("nonce-teach"));
  expect(latest.pendingSends).toEqual([]);
});

it("clears the saved draft on retry only when raw text and mention bindings still match", async () => {
  const key = composerDraftKey({ botId: "bot-1" });
  const accepted = vi.fn();
  const unsubscribe = subscribeComposerDraftAccepted(key, accepted);
  try {
    // Raw field text (padded spaces / pre-skill text) is captured from beginComposerDraftSubmission
    // so retrying a serialized prompt still clears the original draft and notifies reopened composers.
    writeComposerDraft(key, " retry clears me ");
    const submission = beginComposerDraftSubmission(key, " retry clears me ");
    const firstFail = deferred<never>();
    rpc.threads.send.mockReturnValueOnce(firstFail.promise);
    let sent!: Promise<boolean>;
    act(() => {
      sent = latest.sendMessage("/review retry clears me", [], "nonce-draft-clear");
    });
    // Simulates picking a reply or attachment while in flight without editing saved text.
    act(() => latest.clearImageConfirmation());
    firstFail.reject(new Error("offline"));
    await act(async () => void (await sent));
    settleComposerDraftSubmission(key, submission, false);

    rpc.threads.send.mockResolvedValueOnce({ runId: "run-2", taskId: "task-2", seq: 7 });
    await act(async () => void (await latest.retryPendingSend("nonce-draft-clear")));
    expect(readComposerDraft(key)).toBe("");
    expect(accepted).toHaveBeenCalledWith(" retry clears me ", null);

    // Same spelling bound to a different mention target must survive an earlier failed send's retry.
    accepted.mockClear();
    const samA = [
      { start: 0, end: 4, mention: { kind: "bot" as const, id: "bot-a", name: "Sam" } },
    ];
    const samB = [
      { start: 0, end: 4, mention: { kind: "bot" as const, id: "bot-b", name: "Sam" } },
    ];
    writeComposerDraft(key, "@Sam", undefined, samA);
    const mentionSub = beginComposerDraftSubmission(key, "@Sam");
    const mentionFail = deferred<never>();
    rpc.threads.send.mockReturnValueOnce(mentionFail.promise);
    act(() => {
      sent = latest.sendMessage("@Sam", [samA[0]!.mention], "nonce-mention-keep");
    });
    act(() => latest.clearImageConfirmation());
    writeComposerDraft(key, "@Sam", undefined, samB);
    mentionFail.reject(new Error("offline"));
    await act(async () => void (await sent));
    settleComposerDraftSubmission(key, mentionSub, false);

    rpc.threads.send.mockResolvedValueOnce({ runId: "run-3", taskId: "task-3", seq: 8 });
    await act(async () => void (await latest.retryPendingSend("nonce-mention-keep")));
    expect(readComposerDraft(key)).toBe("@Sam");
    expect(readComposerDraftBindings(key)).toEqual(samB);
    expect(accepted).not.toHaveBeenCalled();

    // A newer typed draft in storage must survive when an earlier failed send succeeds on retry.
    writeComposerDraft(key, "first message");
    const secondFail = deferred<never>();
    rpc.threads.send.mockReturnValueOnce(secondFail.promise);
    act(() => {
      sent = latest.sendMessage("first message", [], "nonce-draft-keep");
    });
    act(() => latest.clearImageConfirmation());
    writeComposerDraft(key, "newer follow-up draft");
    secondFail.reject(new Error("offline"));
    await act(async () => void (await sent));

    rpc.threads.send.mockResolvedValueOnce({ runId: "run-4", taskId: "task-4", seq: 9 });
    await act(async () => void (await latest.retryPendingSend("nonce-draft-keep")));
    expect(readComposerDraft(key)).toBe("newer follow-up draft");
  } finally {
    unsubscribe();
    writeComposerDraft(key, "");
  }
});

it("keeps a failed row when another tab edits the chat draft before the send fails", async () => {
  const key = composerDraftKey({ botId: "bot-1" });
  writeComposerDraft(key, "sent before tab edit");
  const submission = beginComposerDraftSubmission(key, "sent before tab edit");
  const reply = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(reply.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("sent before tab edit", [], "nonce-cross-tab-fail");
  });
  // Another tab edits the saved draft without incrementing this tab's local edit counter.
  writeComposerDraft(key, "newer draft from another tab");
  reply.reject(new Error("offline"));
  await act(async () => void (await sent));
  settleComposerDraftSubmission(key, submission, false);

  expect(latest.pendingSends).toEqual([
    expect.objectContaining({
      clientNonce: "nonce-cross-tab-fail",
      text: "sent before tab edit",
      error: "offline",
    }),
  ]);
  expect(latest.hasFailedSend("nonce-cross-tab-fail")).toBe(true);
  expect(readComposerDraft(key)).toBe("newer draft from another tab");
  writeComposerDraft(key, "");
});

it("preserves failed sends across space remounts scoped by account and space", async () => {
  me = { userId: "user-1", spaceId: "space-a" } as Me;
  act(() => root.render(<Harness />));

  const reply = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(reply.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("survives space switch", [], "nonce-space-a");
  });
  act(() => latest.clearImageConfirmation());
  reply.reject(new Error("offline"));
  await act(async () => void (await sent));
  expect(latest.pendingSends).toHaveLength(1);

  // Switch to Space B (remounts the shell): Space B must not show Space A's row,
  // while unsaved-work protection stays active until Space A's row is resolved.
  act(() => root.unmount());
  me = { userId: "user-1", spaceId: "space-b" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
  expect(latest.pendingSends).toEqual([]);
  expect(composerHoldsUnsavedWork()).toBe(true);

  // Returning to Space A restores the failed row and its retry payload.
  act(() => root.unmount());
  me = { userId: "user-1", spaceId: "space-a" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
  expect(latest.pendingSends).toEqual([
    expect.objectContaining({
      clientNonce: "nonce-space-a",
      text: "survives space switch",
      error: "offline",
    }),
  ]);
  expect(latest.hasFailedSend("nonce-space-a")).toBe(true);

  // A different user never inherits the previous user's failed sends.
  act(() => root.unmount());
  me = { userId: "user-2", spaceId: "space-a" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
  expect(latest.pendingSends).toEqual([]);
  expect(composerHoldsUnsavedWork()).toBe(false);
});

it("updates a remounted space shell when an in-flight failure or retry settles", async () => {
  me = { userId: "user-1", spaceId: "space-a" } as Me;
  activeSnapshot = { threadId: "t-1", messages: [] } as unknown as ThreadSnapshot;
  act(() => root.render(<Harness />));

  // Start an edited send in Space A, switch to Space B and return before it fails.
  const firstFail = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(firstFail.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("fails after remount", [], "nonce-remount-settle");
  });
  act(() => latest.clearImageConfirmation());

  act(() => root.unmount());
  me = { userId: "user-1", spaceId: "space-b" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));

  act(() => root.unmount());
  me = { userId: "user-1", spaceId: "space-a" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
  expect(latest.pendingSends).toEqual([]);

  firstFail.reject(new Error("offline"));
  await act(async () => void (await sent));
  expect(latest.pendingSends).toEqual([
    expect.objectContaining({
      clientNonce: "nonce-remount-settle",
      text: "fails after remount",
      error: "offline",
    }),
  ]);
  expect(latest.transcriptProps.failedPendingSends?.get("nonce-remount-settle")).toBe("offline");
  expect(latest.hasFailedSend("nonce-remount-settle")).toBe(true);

  // Start retrying in Space A, switch to Space B and return before the retry succeeds.
  const retryReply = deferred<{ runId: string; taskId: string; seq: number }>();
  rpc.threads.send.mockReturnValueOnce(retryReply.promise);
  const refreshSpy = vi.fn(async () => ({}) as ThreadSnapshot);
  refreshThread = refreshSpy;
  let retried!: Promise<boolean>;
  act(() => {
    retried = latest.retryPendingSend("nonce-remount-settle");
  });

  act(() => root.unmount());
  me = { userId: "user-1", spaceId: "space-b" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));

  act(() => root.unmount());
  me = { userId: "user-1", spaceId: "space-a" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
  expect(latest.transcriptProps.failedPendingSends?.get("nonce-remount-settle")).toBe("offline");

  retryReply.resolve({ runId: "run-2", taskId: "task-2", seq: 11 });
  await act(async () => void (await retried));
  expect(latest.transcriptProps.failedPendingSends).toBeUndefined();
  expect(latest.pendingSends).toEqual([
    expect.objectContaining({
      clientNonce: "nonce-remount-settle",
      acceptedSeq: 11,
      error: undefined,
    }),
  ]);
  expect(composerHoldsUnsavedWork()).toBe(false);
  expect(refreshSpy).toHaveBeenCalledWith("bot-1");
});

it("does not recreate an orphan failed row when an in-flight send or retry fails after chat deletion", async () => {
  me = { userId: "user-1", spaceId: "space-a" } as Me;
  act(() => root.render(<Harness />));

  const sendReply = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(sendReply.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("deleted mid-send", [], "nonce-del-inflight");
  });
  act(() => latest.clearImageConfirmation());
  act(() => latest.discardThreadAttachments("bot-1"));

  sendReply.reject(new Error("offline"));
  await act(async () => void (await sent));
  expect(latest.pendingSends).toEqual([]);
  expect(latest.transcriptProps.failedPendingSends).toBeUndefined();
  expect(composerHoldsUnsavedWork()).toBe(false);

  // Also ensure deleting a chat while a retry is in flight blocks the late retry failure.
  activeChat = "bot-2";
  activeBotId.current = "bot-2";
  act(() => root.render(<Harness />));
  const initialFail = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(initialFail.promise);
  act(() => {
    sent = latest.sendMessage("deleted mid-retry", [], "nonce-del-retry");
  });
  act(() => latest.clearImageConfirmation());
  initialFail.reject(new Error("offline"));
  await act(async () => void (await sent));
  expect(composerHoldsUnsavedWork()).toBe(true);

  const retryFail = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(retryFail.promise);
  let retried!: Promise<boolean>;
  act(() => {
    retried = latest.retryPendingSend("nonce-del-retry");
  });
  act(() => latest.discardThreadAttachments("bot-2"));

  retryFail.reject(new Error("offline"));
  await act(async () => void (await retried));
  expect(latest.pendingSends).toEqual([]);
  expect(latest.transcriptProps.failedPendingSends).toBeUndefined();
  expect(composerHoldsUnsavedWork()).toBe(false);
});

it.each(["dismiss", "retry"] as const)(
  "does not resurrect a failed row when an older space retry fails after %s in a remounted shell",
  async (action) => {
    me = { userId: "user-1", spaceId: "space-a" } as Me;
    activeSnapshot = { threadId: "t-1", messages: [] } as unknown as ThreadSnapshot;
    act(() => root.render(<Harness />));

    const initialFail = deferred<never>();
    rpc.threads.send.mockReturnValueOnce(initialFail.promise);
    let sent!: Promise<boolean>;
    act(() => {
      sent = latest.sendMessage("stale retry target", [], `nonce-stale-${action}`);
    });
    act(() => latest.clearImageConfirmation());
    initialFail.reject(new Error("offline"));
    await act(async () => void (await sent));

    // Start a retry in Space A, then switch Spaces and return while that retry is still pending.
    const oldRetry = deferred<never>();
    rpc.threads.send.mockReturnValueOnce(oldRetry.promise);
    let oldRetryPromise!: Promise<boolean>;
    act(() => {
      oldRetryPromise = latest.retryPendingSend(`nonce-stale-${action}`);
    });

    act(() => root.unmount());
    me = { userId: "user-1", spaceId: "space-b" } as Me;
    root = createQueryRoot(document.createElement("div"));
    act(() => root.render(<Harness />));

    act(() => root.unmount());
    me = { userId: "user-1", spaceId: "space-a" } as Me;
    root = createQueryRoot(document.createElement("div"));
    act(() => root.render(<Harness />));
    expect(latest.transcriptProps.failedPendingSends?.has(`nonce-stale-${action}`)).toBe(true);

    if (action === "dismiss") {
      act(() => latest.discardPendingSend(`nonce-stale-${action}`));
      expect(latest.pendingSends).toEqual([]);
    } else {
      rpc.threads.send.mockResolvedValueOnce({ runId: "run-2", taskId: "task-2", seq: 15 });
      await act(async () => void (await latest.retryPendingSend(`nonce-stale-${action}`)));
      expect(latest.transcriptProps.failedPendingSends).toBeUndefined();
    }

    // When the superseded first retry finally rejects, it must not recreate the failed row.
    oldRetry.reject(new Error("timeout"));
    await act(async () => void (await oldRetryPromise));
    expect(latest.transcriptProps.failedPendingSends).toBeUndefined();
    expect(composerHoldsUnsavedWork()).toBe(false);
    if (action === "dismiss") {
      expect(latest.pendingSends).toEqual([]);
    } else {
      expect(latest.pendingSends).toEqual([
        expect.objectContaining({
          clientNonce: `nonce-stale-${action}`,
          acceptedSeq: 15,
          error: undefined,
        }),
      ]);
    }
  },
);

it("keeps an accepted pending row when a concurrent second retry fails after the first succeeds", async () => {
  me = { userId: "user-1", spaceId: "space-a" } as Me;
  activeSnapshot = { threadId: "t-1", messages: [] } as unknown as ThreadSnapshot;
  act(() => root.render(<Harness />));

  const initialFail = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(initialFail.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("concurrent retry order", [], "nonce-concurrent-order");
  });
  act(() => latest.clearImageConfirmation());
  initialFail.reject(new Error("offline"));
  await act(async () => void (await sent));

  const firstRetry = deferred<{ runId: string; taskId: string; seq: number }>();
  rpc.threads.send.mockReturnValueOnce(firstRetry.promise);
  let firstRetryPromise!: Promise<boolean>;
  act(() => {
    firstRetryPromise = latest.retryPendingSend("nonce-concurrent-order");
  });

  // Switch Spaces and return while the first retry is still pending, then start a second retry.
  act(() => root.unmount());
  me = { userId: "user-1", spaceId: "space-b" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));

  act(() => root.unmount());
  me = { userId: "user-1", spaceId: "space-a" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));

  const secondRetry = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(secondRetry.promise);
  let secondRetryPromise!: Promise<boolean>;
  act(() => {
    secondRetryPromise = latest.retryPendingSend("nonce-concurrent-order");
  });

  // First retry succeeds first; the remounted shell marks the row accepted with seq 22.
  firstRetry.resolve({ runId: "run-2", taskId: "task-2", seq: 22 });
  await act(async () => void (await firstRetryPromise));
  expect(latest.pendingSends).toEqual([
    expect.objectContaining({
      clientNonce: "nonce-concurrent-order",
      acceptedSeq: 22,
      error: undefined,
    }),
  ]);

  // Second retry then fails; it must keep the accepted row in the transcript until sync catches up.
  secondRetry.reject(new Error("timeout"));
  await act(async () => void (await secondRetryPromise));
  expect(latest.pendingSends).toEqual([
    expect.objectContaining({
      clientNonce: "nonce-concurrent-order",
      acceptedSeq: 22,
      error: undefined,
    }),
  ]);
  expect(latest.transcriptProps.failedPendingSends).toBeUndefined();
  expect(composerHoldsUnsavedWork()).toBe(false);
});

it("clears the composer error for an accepted retry nonce while preserving unrelated errors", async () => {
  me = { userId: "user-1", spaceId: "space-a" } as Me;
  activeSnapshot = { threadId: "t-1", messages: [] } as unknown as ThreadSnapshot;
  act(() => root.render(<Harness />));

  const initialFail = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(initialFail.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("reversed retry order", [], "nonce-reversed-order");
  });
  act(() => latest.clearImageConfirmation());
  initialFail.reject(new Error("offline"));
  await act(async () => void (await sent));

  const firstRetry = deferred<{ runId: string; taskId: string; seq: number }>();
  rpc.threads.send.mockReturnValueOnce(firstRetry.promise);
  let firstRetryPromise!: Promise<boolean>;
  act(() => {
    firstRetryPromise = latest.retryPendingSend("nonce-reversed-order");
  });

  // Switch Spaces and return while the first retry is still pending, then start a second retry.
  act(() => root.unmount());
  me = { userId: "user-1", spaceId: "space-b" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));

  act(() => root.unmount());
  me = { userId: "user-1", spaceId: "space-a" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));

  const secondRetry = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(secondRetry.promise);
  let secondRetryPromise!: Promise<boolean>;
  act(() => {
    secondRetryPromise = latest.retryPendingSend("nonce-reversed-order");
  });

  // Second retry rejects first and sets the composer error for this nonce.
  secondRetry.reject(new Error("temporary outage"));
  await act(async () => void (await secondRetryPromise));
  expect(latest.sendError).toBe("temporary outage");

  // First retry then succeeds: the stale error for that nonce clears.
  firstRetry.resolve({ runId: "run-2", taskId: "task-2", seq: 25 });
  await act(async () => void (await firstRetryPromise));
  expect(latest.sendError).toBeNull();
  expect(latest.transcriptProps.failedPendingSends).toBeUndefined();

  // An unrelated composer error must stay when another nonce's retry succeeds.
  const secondInitialFail = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(secondInitialFail.promise);
  act(() => {
    sent = latest.sendMessage("second row", [], "nonce-unrelated-err");
  });
  act(() => latest.clearImageConfirmation());
  secondInitialFail.reject(new Error("offline"));
  await act(async () => void (await sent));

  const remoteRetry = deferred<{ runId: string; taskId: string; seq: number }>();
  rpc.threads.send.mockReturnValueOnce(remoteRetry.promise);
  let remoteRetryPromise!: Promise<boolean>;
  act(() => {
    remoteRetryPromise = latest.retryPendingSend("nonce-unrelated-err");
  });

  act(() => root.unmount());
  me = { userId: "user-1", spaceId: "space-b" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));

  act(() => root.unmount());
  me = { userId: "user-1", spaceId: "space-a" } as Me;
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));

  act(() => latest.setSendError("Could not update reaction"));
  remoteRetry.resolve({ runId: "run-3", taskId: "task-3", seq: 26 });
  await act(async () => void (await remoteRetryPromise));
  expect(latest.sendError).toBe("Could not update reaction");
});

it("keeps the send error banner visible when restoring a failed send back into the composer", async () => {
  const reply = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(reply.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("first words", [], "nonce-restore-keep-err");
  });
  act(() => latest.clearImageConfirmation());
  reply.reject(new Error("network offline"));
  await act(async () => void (await sent));

  expect(latest.sendError).toBe("network offline");
  expect(latest.pendingSends).toHaveLength(1);

  // Automatic restoration (e.g. queued dictation merge) drops the failed row but keeps the banner.
  act(() => latest.restorePendingSend("nonce-restore-keep-err"));
  expect(latest.pendingSends).toEqual([]);
  expect(latest.sendError).toBe("network offline");
});

it("strips the retried prefix when post-leave dictation appended to a failing send", async () => {
  const key = composerDraftKey({ botId: "bot-1" });
  const replaced = vi.fn();
  const unsubscribe = subscribeComposerDraftReplaced(key, replaced);
  try {
    writeComposerDraft(key, "book a train");
    const submission = beginComposerDraftSubmission(key, "book a train");
    const firstFail = deferred<never>();
    rpc.threads.send.mockReturnValueOnce(firstFail.promise);
    let sent!: Promise<boolean>;
    act(() => {
      sent = latest.sendMessage("book a train", [], "nonce-post-leave-dictate");
    });

    // Dictation finishes after leaving the chat and appends to the still-in-flight draft.
    appendComposerDraftText(key, "and a hotel");
    expect(readComposerDraft(key)).toBe("book a train and a hotel");

    firstFail.reject(new Error("offline"));
    await act(async () => void (await sent));
    settleComposerDraftSubmission(key, submission, false);
    expect(latest.transcriptProps.failedPendingSends?.has("nonce-post-leave-dictate")).toBe(true);
    expect(readComposerDraft(key)).toBe("book a train and a hotel");

    // Retrying the failed row succeeds and strips the already-sent prefix, leaving only the new words.
    replaced.mockClear();
    rpc.threads.send.mockResolvedValueOnce({ runId: "run-2", taskId: "task-2", seq: 30 });
    await act(async () => void (await latest.retryPendingSend("nonce-post-leave-dictate")));
    expect(readComposerDraft(key)).toBe("and a hotel");
    expect(replaced).toHaveBeenCalledWith("and a hotel");
  } finally {
    unsubscribe();
    writeComposerDraft(key, "");
  }
});

it("clears the matching saved draft when dismissing a failed reply, while keeping a newer draft", async () => {
  const key = composerDraftKey({ botId: "bot-1" });
  const accepted = vi.fn();
  const unsubscribe = subscribeComposerDraftAccepted(key, accepted);
  try {
    writeComposerDraft(key, "reply text to drop");
    const sub = beginComposerDraftSubmission(key, "reply text to drop");
    const firstFail = deferred<never>();
    rpc.threads.send.mockReturnValueOnce(firstFail.promise);
    let sent!: Promise<boolean>;
    act(() => {
      sent = latest.sendMessage("reply text to drop", [], "nonce-dismiss-reply");
    });
    // Picking another reply target increments draftEditsByThread while leaving storage untouched.
    act(() => latest.clearImageConfirmation());
    firstFail.reject(new Error("offline"));
    await act(async () => void (await sent));
    settleComposerDraftSubmission(key, sub, false);
    expect(readComposerDraft(key)).toBe("reply text to drop");

    act(() => latest.discardPendingSend("nonce-dismiss-reply"));
    expect(readComposerDraft(key)).toBe("");
    expect(accepted).toHaveBeenCalledWith("reply text to drop", null);

    // If the user already typed a newer draft, dismissing keeps that newer draft untouched.
    accepted.mockClear();
    writeComposerDraft(key, "older failed text");
    const secondFail = deferred<never>();
    rpc.threads.send.mockReturnValueOnce(secondFail.promise);
    act(() => {
      sent = latest.sendMessage("older failed text", [], "nonce-dismiss-keep-newer");
    });
    act(() => latest.clearImageConfirmation());
    writeComposerDraft(key, "newer draft stays");
    secondFail.reject(new Error("offline"));
    await act(async () => void (await sent));

    act(() => latest.discardPendingSend("nonce-dismiss-keep-newer"));
    expect(readComposerDraft(key)).toBe("newer draft stays");
    expect(accepted).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    writeComposerDraft(key, "");
  }
});

it("clears a deleted chat's failed sends and releases composerHoldsUnsavedWork", async () => {
  const reply = deferred<never>();
  rpc.threads.send.mockReturnValueOnce(reply.promise);
  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("orphan on delete", [], "nonce-delete-chat");
  });
  act(() => latest.clearImageConfirmation());
  reply.reject(new Error("offline"));
  await act(async () => void (await sent));

  expect(composerHoldsUnsavedWork()).toBe(true);
  act(() => latest.discardThreadAttachments("bot-1"));
  expect(latest.pendingSends).toEqual([]);
  expect(composerHoldsUnsavedWork()).toBe(false);
});

it("refuses text over the message limit before any request and keeps the draft", async () => {
  rpc.threads.send.mockResolvedValue({ runId: "run-1", taskId: "task-1" });
  let accepted!: boolean;
  await act(async () => {
    accepted = await latest.sendMessage("a".repeat(THREAD_MESSAGE_TEXT_MAX_LENGTH + 1), [], "n-1");
  });
  expect(accepted).toBe(false);
  expect(rpc.threads.send).not.toHaveBeenCalled();
  expect(latest.sendError).toBe("Messages can be up to 100,000 characters.");
  expect(latest.pendingSends).toEqual([]);

  await act(async () => {
    accepted = await latest.sendMessage("a".repeat(THREAD_MESSAGE_TEXT_MAX_LENGTH), [], "n-2");
  });
  expect(accepted).toBe(true);
  expect(rpc.threads.send).toHaveBeenCalledTimes(1);
});
