import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_AUDIO_MIME_TYPES,
  ATTACHMENT_MAX_BYTES,
  isAllowedAttachmentMimeType,
  isAttachmentAudioMimeType,
  MessageBlock,
  validateThreadsSendInput,
} from "./index.js";

describe("attachment contracts", () => {
  it.each(ATTACHMENT_AUDIO_MIME_TYPES)("allows %s as an audio file block", (mimeType) => {
    expect(isAllowedAttachmentMimeType(mimeType)).toBe(true);
    expect(isAttachmentAudioMimeType(mimeType)).toBe(true);
    expect(
      MessageBlock.parse({ kind: "file", artifactId: "audio-1", mimeType, name: "clip", size: 42 }),
    ).toMatchObject({ kind: "file", mimeType });
  });
  it("rejects unknown audio and preserves the upload limit", () => {
    expect(isAllowedAttachmentMimeType("audio/flac")).toBe(false);
    expect(isAttachmentAudioMimeType("audio/flac")).toBe(false);
    expect(isAttachmentAudioMimeType("video/mp4")).toBe(false);
    expect(ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
  it("parses image and file message blocks", () => {
    expect(
      MessageBlock.parse({
        kind: "image",
        artifactId: "art_1",
        mimeType: "image/png",
        name: "shot.png",
      }),
    ).toMatchObject({ kind: "image", name: "shot.png" });
    expect(
      MessageBlock.parse({
        kind: "file",
        artifactId: "art_2",
        mimeType: "application/pdf",
        name: "brief.pdf",
        size: 1234,
      }),
    ).toMatchObject({ kind: "file", size: 1234 });
  });

  it("requires text or attachments for threads.send", () => {
    expect(validateThreadsSendInput({ text: "hello" })).toBe(true);
    expect(validateThreadsSendInput({ artifactIds: ["art_1"] })).toBe(true);
    expect(validateThreadsSendInput({})).toBe(false);
    expect(validateThreadsSendInput({ artifactIds: ["a", "b", "c", "d", "e"] })).toBe(true);
  });
});
