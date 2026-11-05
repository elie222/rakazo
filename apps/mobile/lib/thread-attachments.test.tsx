// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PickedAttachment } from "./pick-attachments";
import { pickDocuments } from "./pick-attachments";
import { useThreadAttachments } from "./thread-attachments";

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
  isIncomingShareCurrent: () => false,
  retryIncomingShare: vi.fn(),
  takeIncomingShare: vi.fn(),
}));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));

let root: Root;
let attachments: ReturnType<typeof useThreadAttachments>;

function Probe({ botId }: { botId: string }) {
  attachments = useThreadAttachments({ botId, readOnly: false });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
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
