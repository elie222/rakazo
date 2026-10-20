import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_AUDIO_MIME_TYPES,
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
  it("rejects unknown audio", () => {
    expect(isAllowedAttachmentMimeType("audio/flac")).toBe(false);
    expect(isAttachmentAudioMimeType("audio/flac")).toBe(false);
    expect(isAttachmentAudioMimeType("video/mp4")).toBe(false);
  });
  it("requires text or attachments for threads.send", () => {
    expect(validateThreadsSendInput({ text: "hello" })).toBe(true);
    expect(validateThreadsSendInput({ artifactIds: ["art_1"] })).toBe(true);
    expect(validateThreadsSendInput({})).toBe(false);
    expect(validateThreadsSendInput({ artifactIds: ["a", "b", "c", "d", "e"] })).toBe(true);
  });
});
