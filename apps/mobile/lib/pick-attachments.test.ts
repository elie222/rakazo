import { attachmentMaxBytes } from "@rakazo/contracts";
import { inferAttachmentMimeType } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { filterPickedAttachments } from "./pick-attachments-filter.js";

describe("filterPickedAttachments", () => {
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
    const result = filterPickedAttachments(0, [candidate, candidate]);
    expect(result.attachments.map((attachment) => attachment.id)).toEqual([
      "notes.txt-12-0",
      "notes.txt-12-1",
    ]);
  });
});
