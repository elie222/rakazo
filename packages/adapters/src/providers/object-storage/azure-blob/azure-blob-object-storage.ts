import { randomUUID } from "node:crypto";
import type * as AzureSdk from "@azure/storage-blob";
import type { ObjectStorage } from "@rakazo/adapter-kit";
import {
  objectStorageConnectionFromEnv,
  PART_BYTES,
  parts,
} from "../../../object-storage-common.js";

/** Bounds each request attempt, from sending it to receiving its response headers. */
const TRY_TIMEOUT_MS = 120_000;
/** A read fails when its body sends nothing for this long, so a store that stops answering mid-body cannot hang a restore. */
const IDLE_BODY_TIMEOUT_MS = 60_000;
const DELETE_CONCURRENCY = 16;

export interface AzureBlobObjectStorageConfig {
  /** Container name. */
  container: string;
  /** Storage account name. */
  account: string;
  accountKey: string;
  /** Account URL; empty uses `https://<account>.blob.core.windows.net`. */
  endpoint?: string;
  /** Prepended to every key, so one container can hold several deployments. */
  prefix: string;
}

/** Reads the shared `OBJECT_STORAGE_*` settings: the bucket is the container, the access key id is the account name and the secret is its key. */
export function azureBlobConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AzureBlobObjectStorageConfig | undefined {
  const connection = objectStorageConnectionFromEnv(env);
  if (!connection) return undefined;
  return {
    container: connection.bucket,
    account: connection.accessKeyId,
    accountKey: connection.secretAccessKey,
    endpoint: connection.endpoint,
    prefix: connection.prefix,
  };
}

export class AzureBlobObjectStorage implements ObjectStorage {
  private container?: Promise<{ sdk: typeof AzureSdk; client: AzureSdk.ContainerClient }>;

  constructor(
    private readonly config: AzureBlobObjectStorageConfig,
    private readonly idleBodyMs = IDLE_BODY_TIMEOUT_MS,
  ) {}

  /** The SDK loads on first use, so deployments without object storage never load it. */
  private connect() {
    this.container ??= import("@azure/storage-blob").then((sdk) => {
      const { account, accountKey, endpoint, container } = this.config;
      const service = new sdk.BlobServiceClient(
        endpoint ?? `https://${account}.blob.core.windows.net`,
        new sdk.StorageSharedKeyCredential(account, accountKey),
        { retryOptions: { tryTimeoutInMs: TRY_TIMEOUT_MS } },
      );
      return { sdk, client: service.getContainerClient(container) };
    });
    return this.container;
  }

  private key(key: string) {
    return `${this.config.prefix}${key}`;
  }

  async put(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    const { client } = await this.connect();
    const blob = client.getBlockBlobClient(this.key(key));
    const source = parts(body, PART_BYTES)[Symbol.asyncIterator]();
    // Closing the source stops packing and releases any file it holds open, on every path.
    try {
      const first = await source.next();
      const second = first.done ? first : await source.next();
      if (second.done) {
        const bytes = first.done ? Buffer.alloc(0) : first.value;
        await blob.upload(bytes, bytes.length);
        return;
      }
      // Block ids are unique to this call, so concurrent uploads to one key never commit each other's blocks.
      // The service discards uncommitted blocks, so a failed upload needs no cleanup.
      const uploadId = randomUUID();
      const blockIds: string[] = [];
      const stage = async (bytes: Buffer) => {
        const blockId = Buffer.from(
          `${uploadId}-${String(blockIds.length).padStart(8, "0")}`,
        ).toString("base64");
        await blob.stageBlock(blockId, bytes, bytes.length);
        blockIds.push(blockId);
      };
      await stage((first as IteratorYieldResult<Buffer>).value);
      await stage(second.value);
      for (let next = await source.next(); !next.done; next = await source.next())
        await stage(next.value);
      await blob.commitBlockList(blockIds);
    } finally {
      await source.return?.(undefined);
    }
  }

  async *get(key: string): AsyncGenerator<Uint8Array> {
    const { client } = await this.connect();
    const controller = new AbortController();
    let idle: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () =>
          controller.abort(
            Object.assign(new Error(`Object storage sent nothing for ${this.idleBodyMs} ms`), {
              code: "ETIMEDOUT",
            }),
          ),
        this.idleBodyMs,
      );
    };
    arm();
    try {
      const { readableStreamBody } = await client
        .getBlobClient(this.key(key))
        .download(0, undefined, { abortSignal: controller.signal });
      if (!readableStreamBody) throw new Error("Object storage returned no body");
      for await (const chunk of readableStreamBody) {
        clearTimeout(idle);
        yield chunk as Uint8Array;
        arm();
      }
    } finally {
      clearTimeout(idle);
    }
  }

  async *list(prefix: string): AsyncGenerator<{ key: string; lastModified: Date }> {
    const { client } = await this.connect();
    for await (const blob of client.listBlobsFlat({ prefix: this.key(prefix) })) {
      if (!blob.name.startsWith(this.config.prefix)) continue;
      yield {
        key: blob.name.slice(this.config.prefix.length),
        lastModified: blob.properties.lastModified ?? new Date(0),
      };
    }
  }

  async delete(keys: readonly string[]): Promise<void> {
    const { client } = await this.connect();
    for (let start = 0; start < keys.length; start += DELETE_CONCURRENCY)
      await Promise.all(
        keys
          .slice(start, start + DELETE_CONCURRENCY)
          .map((key) =>
            client.getBlobClient(this.key(key)).deleteIfExists({ deleteSnapshots: "include" }),
          ),
      );
  }
}
