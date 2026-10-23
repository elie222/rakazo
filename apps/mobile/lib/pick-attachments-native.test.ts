import { attachmentMaxBytes } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const file = vi.hoisted(() => ({
  size: 11 * 1024 * 1024,
  base64: vi.fn().mockResolvedValue("aGVsbG8="),
}));
vi.mock("./incoming-share", () => ({ readIncomingShareFile: vi.fn() }));
vi.mock("expo-file-system", () => ({
  File: class {
    info() {
      return { size: file.size };
    }
    base64() {
      return file.base64();
    }
  },
}));
vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn().mockResolvedValue({
    canceled: false,
    assets: [{ name: "large.txt", mimeType: "text/plain", uri: "file:///fake/large.txt" }],
  }),
}));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: vi.fn(() => ({})),
}));

import { pickDocuments } from "./pick-attachments";

beforeEach(() => file.base64.mockClear());

describe("native attachment reads", () => {
  it("reads a file above 10 MiB when the server allows it", async () => {
    const result = await pickDocuments(
      0,
      attachmentMaxBytes({ maxUploadSizeBytes: 12 * 1024 * 1024 }),
    );
    expect(result.attachments).toHaveLength(1);
    expect(file.base64).toHaveBeenCalledOnce();
  });

  it("skips the read when the file exceeds the server limit or older-server default", async () => {
    for (const config of [{ maxUploadSizeBytes: 2 * 1024 * 1024 }, {}]) {
      const result = await pickDocuments(0, attachmentMaxBytes(config));
      expect(result.attachments).toHaveLength(0);
      expect(result.skipped[0]?.reason).toBe(
        config.maxUploadSizeBytes ? "over 2 MiB" : "over 10 MiB",
      );
    }
    expect(file.base64).not.toHaveBeenCalled();
  });
});
