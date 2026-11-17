import { describe, expect, it } from "vitest";
import { createObjectStorage } from "./create-object-storage.js";
import { AzureBlobObjectStorage } from "./providers/object-storage/azure-blob/azure-blob-object-storage.js";
import { S3ObjectStorage } from "./providers/object-storage/s3/s3-object-storage.js";

describe("createObjectStorage", () => {
  const base = {
    OBJECT_STORAGE_BUCKET: "homes",
    OBJECT_STORAGE_ACCESS_KEY_ID: "id",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
  };

  it("is off without a bucket", () => {
    expect(createObjectStorage({ OBJECT_STORAGE_PROTOCOL: "azure-blob" })).toBeUndefined();
  });

  it("defaults to the S3-compatible backend", () => {
    expect(createObjectStorage(base)).toBeInstanceOf(S3ObjectStorage);
    expect(createObjectStorage({ ...base, OBJECT_STORAGE_PROTOCOL: "S3" })).toBeInstanceOf(
      S3ObjectStorage,
    );
  });

  it("selects the Azure Blob backend", () => {
    expect(createObjectStorage({ ...base, OBJECT_STORAGE_PROTOCOL: "azure-blob" })).toBeInstanceOf(
      AzureBlobObjectStorage,
    );
  });

  it("rejects an unknown protocol", () => {
    expect(() => createObjectStorage({ ...base, OBJECT_STORAGE_PROTOCOL: "ftp" })).toThrow(
      /OBJECT_STORAGE_PROTOCOL/,
    );
  });
});
