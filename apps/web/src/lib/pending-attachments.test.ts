import { describe, expect, it, vi } from "vitest";
import { isFileDrag, revokePendingAttachmentPreviews } from "./pending-attachments.js";

function dragData(types: string[], itemKinds: string[] = []) {
  return {
    types,
    items: itemKinds.map((kind) => ({ kind })),
  } as unknown as DataTransfer;
}

describe("isFileDrag", () => {
  it("recognizes files advertised by the drag data", () => {
    expect(isFileDrag(dragData(["Files"]))).toBe(true);
  });

  it("recognizes file items when the Files type is not exposed", () => {
    expect(isFileDrag(dragData([], ["file"]))).toBe(true);
  });

  it("ignores text and other drags", () => {
    expect(isFileDrag(dragData(["text/plain"], ["string"]))).toBe(false);
    expect(isFileDrag(null)).toBe(false);
  });
});

describe("revokePendingAttachmentPreviews", () => {
  it("revokes each preview URL and skips entries without one", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    revokePendingAttachmentPreviews([{ previewUrl: "blob:a" }, {}, { previewUrl: "blob:b" }]);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith("blob:a");
    expect(revoke).toHaveBeenCalledWith("blob:b");
    revoke.mockRestore();
  });
});
