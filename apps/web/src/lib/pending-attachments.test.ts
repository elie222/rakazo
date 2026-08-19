import { describe, expect, it, vi } from "vitest";
import { revokePendingAttachmentPreviews } from "./pending-attachments.js";

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
