import { describe, expect, it } from "vitest";
import { AzureBlobObjectStorage } from "../providers/object-storage/azure-blob/azure-blob-object-storage.js";
import { S3ObjectStorage } from "../providers/object-storage/s3/s3-object-storage.js";
import { createObjectStorage } from "./create-object-storage.js";

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

  it("refuses an Entra kind under the S3 protocol", () => {
    // Without this guard the S3 client would sign its requests with the Entra secret, or fail
    // on an unrelated missing-field message, when all that is wrong is the protocol line.
    expect(() =>
      createObjectStorage({
        ...base,
        OBJECT_STORAGE_AUTH: "managed-identity",
      }),
    ).toThrow(/OBJECT_STORAGE_AUTH applies only with OBJECT_STORAGE_PROTOCOL=azure-blob/);
    expect(() =>
      createObjectStorage({
        ...base,
        OBJECT_STORAGE_AUTH: "CLIENT-SECRET",
      }),
    ).toThrow(/OBJECT_STORAGE_AUTH applies only with OBJECT_STORAGE_PROTOCOL=azure-blob/);
    expect(createObjectStorage({ ...base, OBJECT_STORAGE_AUTH: "account-key" })).toBeInstanceOf(
      S3ObjectStorage,
    );
  });

  it("ignores the auth kind when storage is off", () => {
    expect(
      createObjectStorage({
        OBJECT_STORAGE_PROTOCOL: "s3",
        OBJECT_STORAGE_AUTH: "managed-identity",
      }),
    ).toBeUndefined();
  });
});
