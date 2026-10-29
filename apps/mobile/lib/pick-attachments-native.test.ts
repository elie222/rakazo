import { attachmentMaxBytes } from "@rakazo/contracts";
import * as DocumentPicker from "expo-document-picker";
import { beforeEach, describe, expect, it, vi } from "vitest";

const file = vi.hoisted(() => ({
  size: 11 * 1024 * 1024,
  sizes: {} as Record<string, number>,
  info: vi.fn(),
  base64: vi.fn().mockResolvedValue("aGVsbG8="),
}));
vi.mock("./incoming-share", () => ({ readIncomingShareFile: vi.fn() }));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(private uri: string) {}
    info() {
      file.info(this.uri);
      return { size: file.sizes[this.uri] ?? file.size };
    }
    base64() {
      return file.base64(this.uri);
    }
  },
}));
vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn().mockResolvedValue({
    canceled: false,
    assets: [
      { name: "large.txt", mimeType: "text/plain", uri: "file:///fake/large.txt", lastModified: 0 },
    ],
  }),
}));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: vi.fn(() => ({})),
}));

import { pickDocuments } from "./pick-attachments";

beforeEach(() => {
  file.size = 11 * 1024 * 1024;
  file.sizes = {};
  file.info.mockClear();
  file.base64.mockReset().mockResolvedValue("aGVsbG8=");
  vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
    canceled: false,
    assets: [
      { name: "large.txt", mimeType: "text/plain", uri: "file:///fake/large.txt", lastModified: 0 },
    ],
  });
});

function document(name: string, mimeType = "text/plain") {
  return { name, mimeType, uri: `file:///fake/${name}`, lastModified: 0 };
}

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

  it("reads only documents that can fill the remaining slots", async () => {
    const assets = Array.from({ length: 6 }, (_, index) => document(`${index}.txt`));
    file.size = 1;
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: false, assets });

    const result = await pickDocuments();

    expect(file.base64.mock.calls.map(([uri]) => uri)).toEqual(
      assets.slice(0, 4).map((a) => a.uri),
    );
    expect(file.info.mock.calls.map(([uri]) => uri)).toEqual(assets.slice(0, 4).map((a) => a.uri));
    expect(result.attachments.map((item) => item.name)).toEqual(
      assets.slice(0, 4).map((a) => a.name),
    );
    expect(result.skipped).toEqual(
      assets.slice(4).map((a) => ({ name: a.name, reason: "max 4 attachments" })),
    );
    expect(new Set(result.attachments.map((item) => item.id)).size).toBe(4);
  });

  it("fills remaining slots after rejected documents without changing order", async () => {
    const assets = [
      document("unknown.unsupported", "application/x-unsupported"),
      document("large.txt"),
      document("first.txt"),
      document("second.txt"),
      document("extra.txt"),
    ];
    file.size = 1;
    file.sizes[assets[1]!.uri] = 3 * 1024 * 1024;
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: false, assets });

    const result = await pickDocuments(2, 2 * 1024 * 1024);

    expect(file.base64.mock.calls.map(([uri]) => uri)).toEqual([
      assets[0]!.uri,
      assets[2]!.uri,
      assets[3]!.uri,
    ]);
    expect(result.attachments.map((item) => item.name)).toEqual(["first.txt", "second.txt"]);
    expect(result.attachments[0]!.id).not.toBe(result.attachments[1]!.id);
    expect(result.skipped).toEqual([
      { name: "unknown.unsupported", reason: "unsupported type" },
      { name: "large.txt", reason: "over 2 MiB" },
      { name: "extra.txt", reason: "max 4 attachments" },
    ]);
  });

  it("does not read documents when there are no remaining slots", async () => {
    const assets = [document("one.txt"), document("two.txt")];
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: false, assets });

    const result = await pickDocuments(4);

    expect(file.base64).not.toHaveBeenCalled();
    expect(file.info).not.toHaveBeenCalled();
    expect(result.attachments).toEqual([]);
    expect(result.skipped).toEqual(
      assets.map((a) => ({ name: a.name, reason: "max 4 attachments" })),
    );
  });

  it("does not fail on an unreadable document after the slots are filled", async () => {
    const assets = [document("accepted.txt"), document("unreadable.txt")];
    file.size = 1;
    file.base64.mockImplementation((uri: string) =>
      uri === assets[1]!.uri
        ? Promise.reject(new Error("read failed"))
        : Promise.resolve("aGVsbG8="),
    );
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: false, assets });

    const result = await pickDocuments(3);

    expect(result.attachments.map((item) => item.name)).toEqual(["accepted.txt"]);
    expect(result.skipped).toEqual([{ name: "unreadable.txt", reason: "max 4 attachments" }]);
    expect(file.base64).toHaveBeenCalledOnce();
  });

  it("returns no results when the picker is canceled", async () => {
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: true, assets: null });
    await expect(pickDocuments()).resolves.toEqual({ attachments: [], skipped: [] });
    expect(file.base64).not.toHaveBeenCalled();
  });

  it("propagates read errors for documents within the remaining slots", async () => {
    file.size = 1;
    file.base64.mockRejectedValue(new Error("read failed"));
    await expect(pickDocuments()).rejects.toThrow("read failed");
  });
});
