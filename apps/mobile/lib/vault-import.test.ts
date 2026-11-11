import * as DocumentPicker from "expo-document-picker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickVaultCsv } from "./vault-import";

const files = vi.hoisted(() => ({
  text: new Map<string, string>(),
  unreadable: new Set<string>(),
  deleted: [] as string[],
}));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: vi.fn() }));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(private readonly uri: string) {}
    get size() {
      return files.text.get(this.uri)?.length ?? 0;
    }
    async text() {
      if (files.unreadable.has(this.uri)) throw new Error("The file is no longer there.");
      return files.text.get(this.uri) ?? "";
    }
    delete() {
      files.deleted.push(this.uri);
    }
  },
}));

function pick(uri: string, size?: number) {
  vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
    canceled: false,
    assets: [{ uri, name: "export.csv", size, lastModified: 0 }],
  } as DocumentPicker.DocumentPickerResult);
}

beforeEach(() => {
  files.text.clear();
  files.unreadable.clear();
  files.deleted.length = 0;
});

describe("pickVaultCsv", () => {
  it("reads the picked export on the device and deletes the copy it read", async () => {
    files.text.set(
      "file:///cache/export.csv",
      "url,username,password\nhttps://example.com,alice,fake-pass",
    );
    pick("file:///cache/export.csv");
    expect(await pickVaultCsv()).toMatchObject({
      rows: [{ origin: "https://example.com", username: "alice", password: "fake-pass" }],
    });
    expect(files.deleted).toEqual(["file:///cache/export.csv"]);
    // Some file providers label a CSV as a spreadsheet or as plain bytes.
    expect(vi.mocked(DocumentPicker.getDocumentAsync).mock.lastCall?.[0]?.type).toEqual(
      expect.arrayContaining(["text/csv", "application/vnd.ms-excel", "application/octet-stream"]),
    );
  });

  it("refuses a file over the limit without reading it, and still deletes the copy", async () => {
    pick("file:///cache/big.csv", 5_000_001);
    expect(await pickVaultCsv()).toEqual({ error: "too_large" });
    expect(files.deleted).toEqual(["file:///cache/big.csv"]);
  });

  it("deletes the copy when reading it fails", async () => {
    files.unreadable.add("file:///cache/gone.csv");
    pick("file:///cache/gone.csv");
    await expect(pickVaultCsv()).rejects.toThrow("The file is no longer there.");
    expect(files.deleted).toEqual(["file:///cache/gone.csv"]);
  });

  it("returns nothing when the person cancels", async () => {
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: true, assets: null });
    expect(await pickVaultCsv()).toBeNull();
  });
});
