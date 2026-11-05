// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { releaseIncomingShareFiles, takeIncomingShare } from "./incoming-share";
import type { PickedAttachment } from "./pick-attachments";
import { pickDocuments, readSharedFiles } from "./pick-attachments";
import { useIncomingShareImport, useThreadAttachments } from "./thread-attachments";

const sessionCaches = vi.hoisted(() => [] as Array<() => void>);
vi.mock("./session", () => ({
  registerSessionDiskCache: (clear: () => void) => sessionCaches.push(clear),
}));

vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));
vi.mock("./pick-attachments", () => ({
  pickDocuments: vi.fn(),
  pickFromLibrary: vi.fn(),
  readDroppedFiles: vi.fn(),
  readSharedFiles: vi.fn(),
  takePhoto: vi.fn(),
}));
vi.mock("./use-file-drop", () => ({ useFileDrop: () => undefined }));
vi.mock("./incoming-share", () => ({
  isIncomingShareCurrent: vi.fn(() => true),
  releaseIncomingShareFiles: vi.fn(),
  retryIncomingShare: vi.fn(),
  takeIncomingShare: vi.fn(),
}));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));

let root: Root;
let attachments: ReturnType<typeof useThreadAttachments>;

/** A chat reopened after leaving it: a fresh screen instance on a fresh root. */
function mount(node: React.ReactNode) {
  root = createRoot(document.createElement("div"));
  act(() => root.render(node));
}

function unmount() {
  act(() => root.unmount());
}

function Probe({
  botId,
  draftScope,
  uploadConfig,
}: {
  botId: string;
  draftScope?: { apiBase: string; userId: string; threadKey: string };
  uploadConfig?: { maxUploadSizeBytes?: number; maxAttachmentsPerMessage?: number };
}) {
  attachments = useThreadAttachments({ botId, readOnly: false, uploadConfig, draftScope });
  return null;
}

const uploadConfig = {};

function ImportProbe({ botId }: { botId: string }) {
  attachments = useThreadAttachments({
    botId,
    readOnly: false,
    uploadConfig,
    draftScope: { apiBase: "https://example.test", userId: "user-1", threadKey: botId },
  });
  useIncomingShareImport({
    attachments,
    composerRef: { current: null },
    readOnly: false,
    threadKey: botId,
    uploadConfig,
  });
  return null;
}

function attachment(id: string, threadKey: string): PickedAttachment & { threadKey: string } {
  return { id, name: `${id}.txt`, mimeType: "text/plain", contentBase64: "aGk=", threadKey };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

it("counts a read that settles before the next render against the attachment limit", async () => {
  function picked(id: string): PickedAttachment {
    return { id, name: `${id}.txt`, mimeType: "text/plain", contentBase64: "aGk=" };
  }
  function pending(id: string) {
    return { ...picked(id), threadKey: "bot-a" };
  }
  act(() => root.render(<Probe botId="bot-a" />));
  act(() => attachments.setPendingAttachments([pending("a1"), pending("a2"), pending("a3")]));
  type PickResult = {
    attachments: PickedAttachment[];
    skipped: Array<{ name: string; reason: string }>;
  };
  let settleFirst!: (result: PickResult) => void;
  let settleSecond!: (result: PickResult) => void;
  vi.mocked(pickDocuments).mockReturnValueOnce(
    new Promise((resolve) => {
      settleFirst = resolve;
    }),
  );
  vi.mocked(pickDocuments).mockReturnValueOnce(
    new Promise((resolve) => {
      settleSecond = resolve;
    }),
  );
  act(() => attachments.attachFrom("file"));
  act(() => attachments.attachFrom("file"));

  // Both reads settle in the same task, before React commits the first one's attachments.
  await act(async () => {
    settleFirst({ attachments: [picked("d1")], skipped: [] });
    settleSecond({ attachments: [picked("d2")], skipped: [] });
  });

  expect(attachments.activePendingAttachments.map((item) => item.id).sort()).toEqual([
    "a1",
    "a2",
    "a3",
    "d1",
  ]);
  // The identity i18n mock leaves the placeholder; before the fix there was no notice at all.
  expect(attachments.attachmentNotice).toBe("Skipped {items}");
});

it("keeps a chat's unsent attachments when the chat is left and reopened", () => {
  const scope = { apiBase: "https://example.test", userId: "user-1", threadKey: "bot-a" };
  mount(<Probe botId="bot-a" draftScope={scope} />);
  act(() => attachments.setPendingAttachments([attachment("a1", "bot-a")]));
  unmount();

  mount(<Probe botId="bot-a" draftScope={scope} />);

  expect(attachments.activePendingAttachments.map((item) => item.id)).toEqual(["a1"]);

  // Another chat, or another account in the same chat, starts without them.
  unmount();
  mount(<Probe botId="bot-b" draftScope={{ ...scope, threadKey: "bot-b" }} />);
  expect(attachments.activePendingAttachments).toEqual([]);
  unmount();
  mount(<Probe botId="bot-a" draftScope={{ ...scope, userId: "user-2" }} />);
  expect(attachments.activePendingAttachments).toEqual([]);
});

it("keeps the iOS share copy until its attachment is sent or removed", async () => {
  const files = [{ uri: "file:///group/a1.txt", name: "a1.txt", mimeType: "text/plain" }];
  vi.mocked(takeIncomingShare).mockReturnValueOnce({
    text: "",
    files,
    arrivedAt: Date.now(),
    generation: 1,
  });
  vi.mocked(readSharedFiles).mockResolvedValueOnce({
    attachments: [attachment("s1", "bot-c")],
    skipped: [],
    failedFiles: [],
    sources: [files[0]!.uri],
  });
  mount(<ImportProbe botId="bot-c" />);

  await act(async () => {});

  expect(attachments.activePendingAttachments.map((item) => item.id)).toEqual(["s1"]);
  expect(releaseIncomingShareFiles).toHaveBeenCalledWith([]);

  act(() =>
    attachments.setPendingAttachments((current) => current.filter((item) => item.id !== "s1")),
  );

  expect(releaseIncomingShareFiles).toHaveBeenCalledWith([
    { uri: "file:///group/a1.txt", name: "", mimeType: null },
  ]);
});

it("restores the destination chat's draft on a warm link to another chat", () => {
  const scope = (threadKey: string) => ({
    apiBase: "https://example.test",
    userId: "user-7",
    threadKey,
  });
  mount(<Probe botId="bot-b" draftScope={scope("bot-b")} />);
  act(() => attachments.setPendingAttachments([attachment("b1", "bot-b")]));
  unmount();

  mount(<Probe botId="bot-a" draftScope={scope("bot-a")} />);
  act(() => attachments.setPendingAttachments([attachment("a1", "bot-a")]));
  // A warm deep link reuses the mounted screen with the other chat's parameters.
  act(() => root.render(<Probe botId="bot-b" draftScope={scope("bot-b")} />));

  expect(attachments.activePendingAttachments.map((item) => item.id)).toEqual(["b1"]);
});

it("bounds retained drafts for inactive chats, dropping the oldest", () => {
  const uploadConfig = { maxUploadSizeBytes: 3, maxAttachmentsPerMessage: 1 };
  const scope = (threadKey: string) => ({
    apiBase: "https://example.test",
    userId: "user-9",
    threadKey,
  });
  // "aGk=" carries 3 bytes, so two chats fill the 6-byte budget and the third drops the first.
  for (const bot of ["bot-x", "bot-y", "bot-z"]) {
    mount(<Probe botId={bot} draftScope={scope(bot)} uploadConfig={uploadConfig} />);
    act(() => attachments.setPendingAttachments([attachment(`${bot}-f`, bot)]));
    unmount();
  }

  mount(<Probe botId="bot-x" draftScope={scope("bot-x")} uploadConfig={uploadConfig} />);
  expect(attachments.activePendingAttachments).toEqual([]);
  unmount();
  mount(<Probe botId="bot-z" draftScope={scope("bot-z")} uploadConfig={uploadConfig} />);
  expect(attachments.activePendingAttachments.map((item) => item.id)).toEqual(["bot-z-f"]);
});

it("clears retained drafts and share copies on a session change", async () => {
  const files = [{ uri: "file:///group/s1.txt", name: "s1.txt", mimeType: "text/plain" }];
  vi.mocked(takeIncomingShare).mockReturnValueOnce({
    text: "",
    files,
    arrivedAt: Date.now(),
    generation: 1,
  });
  vi.mocked(readSharedFiles).mockResolvedValueOnce({
    attachments: [attachment("s1", "bot-d")],
    skipped: [],
    failedFiles: [],
    sources: [files[0]!.uri],
  });
  mount(<ImportProbe botId="bot-d" />);
  await act(async () => {});
  unmount();
  vi.mocked(releaseIncomingShareFiles).mockClear();

  expect(sessionCaches).toHaveLength(1);
  act(() => sessionCaches[0]!());

  mount(<ImportProbe botId="bot-d" />);
  await act(async () => {});
  expect(attachments.activePendingAttachments).toEqual([]);
  expect(releaseIncomingShareFiles).toHaveBeenCalledWith([
    { uri: "file:///group/s1.txt", name: "", mimeType: null },
  ]);
});
