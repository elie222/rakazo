import { attachmentMaxBytes } from "@rakazo/contracts";
import * as core from "@rakazo/core";
import { inferAttachmentMimeType } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { filterPickedAttachments } from "./pick-attachments-filter.js";

describe("filterPickedAttachments", () => {
  it("accepts picked MP3 audio but retains the 10 MiB cap", () => {
    const candidate = {
      name: "song.mp3",
      mimeType: inferAttachmentMimeType("song.mp3", "audio/mp3"),
      size: 10 * 1024 * 1024,
      contentBase64: "YXVkaW8=",
    };
    const result = filterPickedAttachments(0, [
      candidate,
      { ...candidate, name: "large.mp3", size: candidate.size + 1 },
    ]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({ name: "song.mp3", mimeType: "audio/mpeg" });
    expect(result.skipped).toEqual([{ name: "large.mp3", reason: "over 10 MiB" }]);
  });
  it("uses the server limit and falls back for older servers", () => {
    const candidate = {
      name: "large.txt",
      mimeType: "text/plain",
      size: 11 * 1024 * 1024,
      contentBase64: "",
    };
    expect(
      filterPickedAttachments(
        0,
        [candidate],
        attachmentMaxBytes({ maxUploadSizeBytes: 12 * 1024 * 1024 }),
      ).attachments,
    ).toHaveLength(1);
    expect(filterPickedAttachments(0, [candidate], attachmentMaxBytes({})).skipped[0]?.reason).toBe(
      "over 10 MiB",
    );
    expect(
      filterPickedAttachments(
        0,
        [candidate],
        attachmentMaxBytes({ maxUploadSizeBytes: 2 * 1024 * 1024 }),
      ).skipped[0]?.reason,
    ).toBe("over 2 MiB");
  });
  it("skips unsupported mime types and oversize files", () => {
    const result = filterPickedAttachments(0, [
      {
        name: "notes.txt",
        mimeType: "text/plain",
        size: 12,
        contentBase64: "aGVsbG8=",
      },
      {
        name: "bundle.zip",
        mimeType: inferAttachmentMimeType("bundle.zip", "application/x-zip-compressed"),
        size: 12,
        contentBase64: "UEsDBA==",
      },
      {
        name: "payload.exe",
        mimeType: null,
        size: 12,
        contentBase64: "aGVsbG8=",
      },
      {
        name: "big.zip",
        mimeType: "application/zip",
        size: 10 * 1024 * 1024 + 1,
        contentBase64: "aGVsbG8=",
      },
    ]);
    expect(result.attachments.map((item) => item.name)).toEqual(["notes.txt", "bundle.zip"]);
    expect(result.attachments[1]).toMatchObject({
      name: "bundle.zip",
      mimeType: "application/zip",
    });
    expect(result.skipped.map((item) => item.name)).toEqual(["payload.exe", "big.zip"]);
  });

  it("assigns distinct ids to duplicate files", () => {
    const candidate = {
      name: "notes.txt",
      mimeType: "text/plain",
      size: 12,
      contentBase64: "aGVsbG8=",
    };
    const ids = vi.spyOn(core, "newClientId").mockReturnValueOnce("a").mockReturnValueOnce("b");
    const result = filterPickedAttachments(0, [candidate, candidate]);
    ids.mockRestore();
    expect(result.attachments).toHaveLength(2);
    expect(new Set(result.attachments.map((attachment) => attachment.id)).size).toBe(2);
    expect(result.skipped).toEqual([]);
  });
  it("keeps identities distinct after removing an earlier pick and selecting more files", () => {
    const a = { name: "first.txt", mimeType: "text/plain", size: 4, contentBase64: "YWFhYQ==" };
    const b = { name: "same.txt", mimeType: "text/plain", size: 4, contentBase64: "YmJiYg==" };
    const c = { ...b, contentBase64: "Y2NjYw==" };
    const d = { ...b, contentBase64: "ZGRkZA==" };
    const ids = vi.spyOn(core, "newClientId");
    ids
      .mockReturnValueOnce("a")
      .mockReturnValueOnce("b")
      .mockReturnValueOnce("c")
      .mockReturnValueOnce("d");
    const first = filterPickedAttachments(0, [a, b]);
    const remaining = first.attachments.slice(1);
    const next = filterPickedAttachments(remaining.length, [c, d]);
    ids.mockRestore();
    const attachments = [...remaining, ...next.attachments];

    expect(first.skipped).toEqual([]);
    expect(next.skipped).toEqual([]);
    expect(attachments.map(({ contentBase64 }) => contentBase64)).toEqual([
      b.contentBase64,
      c.contentBase64,
      d.contentBase64,
    ]);
    expect(new Set(attachments.map(({ id }) => id)).size).toBe(3);
    expect(new Set([...first.attachments, ...next.attachments].map(({ id }) => id)).size).toBe(4);
  });
});
