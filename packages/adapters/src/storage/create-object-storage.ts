import type { ObjectStorage } from "@rakazo/adapter-kit";
import {
  AzureBlobObjectStorage,
  azureBlobConfigFromEnv,
} from "../providers/object-storage/azure-blob/azure-blob-object-storage.js";
import {
  objectStorageConfigFromEnv,
  S3ObjectStorage,
} from "../providers/object-storage/s3/s3-object-storage.js";

/**
 * The object storage this deployment is configured for, or undefined when
 * `OBJECT_STORAGE_BUCKET` is unset. `OBJECT_STORAGE_PROTOCOL` picks the backend and defaults to
 * `s3`, which covers every S3-compatible service.
 */
export function createObjectStorage(
  env: NodeJS.ProcessEnv = process.env,
): ObjectStorage | undefined {
  const protocol = env.OBJECT_STORAGE_PROTOCOL?.trim().toLowerCase() || "s3";
  const auth = env.OBJECT_STORAGE_AUTH?.trim().toLowerCase() || "account-key";
  if (protocol === "azure-blob") {
    const config = azureBlobConfigFromEnv(env);
    return config && new AzureBlobObjectStorage(config);
  }
  if (protocol !== "s3") throw new Error('OBJECT_STORAGE_PROTOCOL must be "s3" or "azure-blob"');
  // An Entra kind without the azure-blob protocol would otherwise be ignored while the S3
  // client signs its requests with whatever the settings hold — refuse at startup instead.
  if (auth !== "account-key")
    throw new Error("OBJECT_STORAGE_AUTH needs OBJECT_STORAGE_PROTOCOL=azure-blob");
  const config = objectStorageConfigFromEnv(env);
  return config && new S3ObjectStorage(config);
}
