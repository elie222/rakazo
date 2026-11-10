// @vitest-environment jsdom

import { act, Suspense, startTransition, use, useLayoutEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { releaseIncomingShareFiles, retryIncomingShare, takeIncomingShare } from "./incoming-share";
import type { PickedAttachment } from "./pick-attachments";
import { pickDocuments, readDroppedFiles, readSharedFiles } from "./pick-attachments";
import { useIncomingShareImport, useThreadAttachments } from "./thread-attachments";

const sessionCaches = vi.hoisted(() => [] as Array<() => void>);
const fileDrop = vi.hoisted(() => ({
  onDrop: undefined as
    | undefined
    | ((drop: { files: unknown[]; skipped: Array<{ name: string; reason: string }> }) => void),
}));
vi.mock("./session", () => ({
  registerSessionDiskCache: (clear: () => void) => sessionCaches.push(clear),
}));

vi.mock("./pick-attachments", () => ({
  pickDocuments: vi.fn(),
  pickFromLibrary: vi.fn(),
  readDroppedFiles: vi.fn(),
  readSharedFiles: vi.fn(),
  takePhoto: vi.fn(),
}));
vi.mock("./use-file-drop", () => ({
  useFileDrop: (_key: unknown, onDrop: NonNullable<typeof fileDrop.onDrop>) => {
    fileDrop.onDrop = onDrop;
  },
}));
vi.mock("./incoming-share", () => ({
  isIncomingShareCurrent: vi.fn(() => true),
  releaseIncomingShareFiles: vi.fn(),
  retryIncomingShare: vi.fn(),
  takeIncomingShare: vi.fn(),
}));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));

let root: Root;
let attachments: ReturnType<typeof useThreadAttachments>;
/** The import probe's state as last committed; a render React discards does not change it. */
let committedAttachments: ReturnType<typeof useThreadAttachments>;

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

const defaultUploadConfig = {};
const twoAttachments = { maxAttachmentsPerMessage: 2 };

function ImportProbe({
  botId,
  uploadConfig = defaultUploadConfig,
}: {
  botId: string;
  uploadConfig?: { maxAttachmentsPerMessage?: number };
}) {
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
  const current = attachments;
  useLayoutEffect(() => {
    committedAttachments = current;
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
  // Before the fix there was no notice at all.
  expect(attachments.attachmentNotice).toBe("Skipped d2.txt (max 4 attachments)");
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

type Read = {
  attachments: PickedAttachment[];
  skipped: Array<{ name: string; reason: string }>;
};
function picked(id: string): PickedAttachment {
  return { id, name: `${id}.txt`, mimeType: "text/plain", contentBase64: "aGk=" };
}
/** A share of two files whose read waits until the returned function settles it. */
function slowShare() {
  const files = ["s1", "s2"].map((id) => ({
    uri: `file:///group/${id}.txt`,
    name: `${id}.txt`,
    mimeType: "text/plain",
  }));
  vi.mocked(takeIncomingShare).mockReturnValueOnce({
    text: "",
    files,
    arrivedAt: Date.now(),
    generation: 1,
  });
  let settle!: () => void;
  vi.mocked(readSharedFiles).mockReturnValueOnce(
    new Promise((resolve) => {
      settle = () =>
        resolve({
          attachments: [picked("s1"), picked("s2")],
          skipped: [],
          failedFiles: [],
          sources: files.map((file) => file.uri),
        });
    }),
  );
  return { files, settle: () => settle() };
}

it("holds a share import to the attachment limit when a picker opened before it settles first", async () => {
  let settlePicker!: (result: Read) => void;
  vi.mocked(pickDocuments).mockReturnValueOnce(
    new Promise((resolve) => {
      settlePicker = resolve;
    }),
  );
  // The picker opens before the share is taken; the new limits then start the import.
  mount(<ImportProbe botId="bot-share-picker" />);
  act(() => attachments.attachFrom("file"));
  const share = slowShare();
  act(() => root.render(<ImportProbe botId="bot-share-picker" uploadConfig={twoAttachments} />));

  await act(async () => settlePicker({ attachments: [picked("d1"), picked("d2")], skipped: [] }));
  await act(async () => share.settle());

  expect(attachments.activePendingAttachments.map((item) => item.id)).toEqual(["d1", "d2"]);
  expect(attachments.attachmentNotice).toBe(
    "Skipped s1.txt (max 2 attachments), s2.txt (max 2 attachments)",
  );
  // Files left out by the limit give their share copies back.
  expect(releaseIncomingShareFiles).toHaveBeenLastCalledWith(share.files);
});

it("holds a share import to the attachment limit when files are dropped during it", async () => {
  const share = slowShare();
  mount(<ImportProbe botId="bot-share-drop" uploadConfig={twoAttachments} />);
  vi.mocked(readDroppedFiles).mockResolvedValueOnce({
    attachments: [picked("d1"), picked("d2")],
    skipped: [],
  });

  await act(async () => fileDrop.onDrop?.({ files: [], skipped: [] }));
  await act(async () => share.settle());

  expect(attachments.activePendingAttachments.map((item) => item.id)).toEqual(["d1", "d2"]);
  expect(attachments.attachmentNotice).toBe(
    "Skipped s1.txt (max 2 attachments), s2.txt (max 2 attachments)",
  );
});

it("keeps the share copy an earlier unsent attachment still uses when a later share overflows", async () => {
  const files = [{ uri: "file:///group/same.txt", name: "same.txt", mimeType: "text/plain" }];
  vi.mocked(takeIncomingShare).mockReturnValueOnce({
    text: "",
    files,
    arrivedAt: Date.now(),
    generation: 1,
  });
  vi.mocked(readSharedFiles).mockResolvedValueOnce({
    attachments: [picked("e1")],
    skipped: [],
    failedFiles: [],
    sources: [files[0]!.uri],
  });
  mount(<ImportProbe botId="bot-share-reuse" uploadConfig={twoAttachments} />);
  await act(async () => {});
  expect(attachments.activePendingAttachments.map((item) => item.id)).toEqual(["e1"]);
  unmount();

  // A later share reuses the file name, so its copy has the same URI as e1's.
  vi.mocked(takeIncomingShare).mockReturnValueOnce({
    text: "",
    files,
    arrivedAt: Date.now(),
    generation: 2,
  });
  let settle!: () => void;
  vi.mocked(readSharedFiles).mockReturnValueOnce(
    new Promise((resolve) => {
      settle = () =>
        resolve({
          attachments: [picked("s1")],
          skipped: [],
          failedFiles: [],
          sources: [files[0]!.uri],
        });
    }),
  );
  vi.mocked(releaseIncomingShareFiles).mockClear();
  mount(<ImportProbe botId="bot-share-reuse" uploadConfig={twoAttachments} />);
  vi.mocked(readDroppedFiles).mockResolvedValueOnce({ attachments: [picked("d1")], skipped: [] });
  // A dropped file takes the last slot while the share is read.
  await act(async () => fileDrop.onDrop?.({ files: [], skipped: [] }));
  await act(async () => settle());

  expect(attachments.activePendingAttachments.map((item) => item.id)).toEqual(["e1", "d1"]);
  expect(releaseIncomingShareFiles).not.toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ uri: files[0]!.uri })]),
  );
});

it("keeps a share whose read settles between a warm link's commit and its effects", async () => {
  const files = [{ uri: "file:///group/w1.txt", name: "w1.txt", mimeType: "text/plain" }];
  const share = { text: "", files, arrivedAt: Date.now(), generation: 1 };
  vi.mocked(takeIncomingShare).mockReturnValueOnce(share);
  let settle!: () => void;
  vi.mocked(readSharedFiles).mockReturnValueOnce(
    new Promise((resolve) => {
      settle = () =>
        resolve({
          attachments: [
            { id: "w1", name: "w1.txt", mimeType: "text/plain", contentBase64: "aGk=" },
          ],
          skipped: [],
          failedFiles: [],
          sources: [files[0]!.uri],
        });
    }),
  );
  /** Settles the read in the warm link's layout phase, after its commit and before its effects. */
  function SettleOnCommit({ botId }: { botId: string }) {
    useLayoutEffect(() => {
      if (botId === "bot-warm-b") settle();
    }, [botId]);
    return null;
  }
  vi.mocked(retryIncomingShare).mockClear();
  vi.mocked(releaseIncomingShareFiles).mockClear();
  mount(<ImportProbe botId="bot-warm-a" />);

  // Outside act, so React schedules the passive effects as it does on a device.
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  root.render(
    <>
      <ImportProbe botId="bot-warm-b" />
      <SettleOnCommit botId="bot-warm-b" />
    </>,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  // The share goes back to the queue, as when the read settles after the switch; it is not dropped.
  expect(retryIncomingShare).toHaveBeenCalledWith(share);
  expect(releaseIncomingShareFiles).not.toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ uri: files[0]!.uri })]),
  );
});

it("keeps a share for the committed chat when a render of another chat is discarded", async () => {
  const files = [{ uri: "file:///group/t1.txt", name: "t1.txt", mimeType: "text/plain" }];
  const share = { text: "", files, arrivedAt: Date.now(), generation: 1 };
  vi.mocked(takeIncomingShare).mockReturnValueOnce(share);
  let settle!: () => void;
  vi.mocked(readSharedFiles).mockReturnValueOnce(
    new Promise((resolve) => {
      settle = () =>
        resolve({
          attachments: [
            { id: "t1", name: "t1.txt", mimeType: "text/plain", contentBase64: "aGk=" },
          ],
          skipped: [],
          failedFiles: [],
          sources: [files[0]!.uri],
        });
    }),
  );
  const never = new Promise<never>(() => {});
  function Suspends(): null {
    use(never);
    return null;
  }
  vi.mocked(retryIncomingShare).mockClear();
  mount(
    <Suspense fallback={null}>
      <ImportProbe botId="bot-kept-a" />
    </Suspense>,
  );

  // A transition renders chat B, which suspends, so chat A stays on screen.
  await act(async () =>
    startTransition(() =>
      root.render(
        <Suspense fallback={null}>
          <ImportProbe botId="bot-kept-b" />
          <Suspends />
        </Suspense>,
      ),
    ),
  );
  await act(async () => settle());
  // The suspended render of chat B is discarded: chat A renders again.
  await act(async () =>
    root.render(
      <Suspense fallback={null}>
        <ImportProbe botId="bot-kept-a" />
      </Suspense>,
    ),
  );

  expect(retryIncomingShare).not.toHaveBeenCalledWith(share);
  const kept = committedAttachments.activePendingAttachments;
  expect(kept.map((item) => item.id)).toEqual(["t1"]);
});
