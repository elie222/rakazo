import { randomUUID } from "node:crypto";
import type * as AzureSdk from "@azure/storage-blob";
import type { ObjectStorage } from "@rakazo/adapter-kit";
import { objectStorageBaseFromEnv, PART_BYTES, parts } from "../../../object-storage-common.js";

/** Bounds each request attempt, from sending it to receiving its response headers. */
const TRY_TIMEOUT_MS = 120_000;
/** A read fails when its body sends nothing for this long, so a store that stops answering mid-body cannot hang a restore. */
const IDLE_BODY_TIMEOUT_MS = 60_000;
const DELETE_CONCURRENCY = 16;

/**
 * How the adapter proves who it is to the storage account. Every mode but the shared key needs
 * an Azure identity, and each names its own credentials rather than taking an SDK's ambient
 * chain, so object storage never borrows an identity configured for something else.
 */
export type AzureBlobAuth =
  /** The account's shared key; no Azure identity required. */
  | { kind: "account-key"; accountKey: string }
  /** A service principal's client secret. */
  | { kind: "client-secret"; tenantId: string; clientId: string; clientSecret: string }
  /** A service principal's certificate, PEM holding the certificate and its private key. */
  | {
      kind: "client-certificate";
      tenantId: string;
      clientId: string;
      certificate: string;
    }
  /** The service account token Kubernetes workload identity projects into the pod. */
  | { kind: "federated-identity"; tenantId: string; clientId: string; tokenFilePath: string }
  /** The host's own managed identity, system-assigned or the named user-assigned one. */
  | { kind: "managed-identity"; clientId?: string };

export interface AzureBlobObjectStorageConfig {
  /** Container name. */
  container: string;
  /** Storage account name. */
  account: string;
  auth: AzureBlobAuth;
  /** Account URL; empty uses `https://<account>.blob.core.windows.net`. */
  endpoint?: string;
  /** Prepended to every key, so one container can hold several deployments. */
  prefix: string;
}

const AUTH_KINDS = [
  "account-key",
  "client-secret",
  "client-certificate",
  "federated-identity",
  "managed-identity",
] as const;

/**
 * The authentication `OBJECT_STORAGE_AUTH` selects, unset meaning the shared key the backend
 * started with. A mode names the variables it needs, so a missing one fails at startup with the
 * variable to set instead of at the first upload.
 */
function azureBlobAuthFromEnv(env: NodeJS.ProcessEnv): AzureBlobAuth {
  const requested = env.OBJECT_STORAGE_AUTH?.trim().toLowerCase() || "account-key";
  if (!(AUTH_KINDS as readonly string[]).includes(requested)) {
    throw new Error(`OBJECT_STORAGE_AUTH must be one of ${AUTH_KINDS.join(", ")}`);
  }
  const kind = requested as (typeof AUTH_KINDS)[number];
  const require = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required with OBJECT_STORAGE_AUTH=${kind}`);
    return value;
  };
  switch (kind) {
    case "account-key":
      return { kind, accountKey: require("OBJECT_STORAGE_SECRET_ACCESS_KEY") };
    case "client-secret":
      return {
        kind,
        tenantId: require("OBJECT_STORAGE_TENANT"),
        clientId: require("OBJECT_STORAGE_CLIENT_ID"),
        clientSecret: require("OBJECT_STORAGE_SECRET_ACCESS_KEY"),
      };
    case "client-certificate":
      return {
        kind,
        tenantId: require("OBJECT_STORAGE_TENANT"),
        clientId: require("OBJECT_STORAGE_CLIENT_ID"),
        certificate: require("OBJECT_STORAGE_CERTIFICATE"),
      };
    case "federated-identity":
      return {
        kind,
        tenantId: require("OBJECT_STORAGE_TENANT"),
        clientId: require("OBJECT_STORAGE_CLIENT_ID"),
        tokenFilePath: require("OBJECT_STORAGE_FEDERATED_TOKEN_FILE"),
      };
    case "managed-identity":
      return { kind, clientId: env.OBJECT_STORAGE_CLIENT_ID?.trim() || undefined };
  }
}

/** Reads the shared `OBJECT_STORAGE_*` settings: the bucket is the container, the access key id is the account name. */
export function azureBlobConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AzureBlobObjectStorageConfig | undefined {
  const base = objectStorageBaseFromEnv(env);
  if (!base) return undefined;
  const account = env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim();
  if (!account) {
    throw new Error(
      "OBJECT_STORAGE_ACCESS_KEY_ID (the storage account name) is required with OBJECT_STORAGE_BUCKET",
    );
  }
  return {
    container: base.bucket,
    account,
    auth: azureBlobAuthFromEnv(env),
    endpoint: base.endpoint,
    prefix: base.prefix,
  };
}

/** The token credential for an identity mode; the shared key never reaches this. */
function tokenCredential(
  identity: typeof import("@azure/identity"),
  auth: Exclude<AzureBlobAuth, { kind: "account-key" }>,
) {
  switch (auth.kind) {
    case "client-secret":
      return new identity.ClientSecretCredential(auth.tenantId, auth.clientId, auth.clientSecret);
    case "client-certificate":
      return new identity.ClientCertificateCredential(auth.tenantId, auth.clientId, {
        certificate: auth.certificate,
      });
    case "federated-identity":
      return new identity.WorkloadIdentityCredential({
        tenantId: auth.tenantId,
        clientId: auth.clientId,
        tokenFilePath: auth.tokenFilePath,
      });
    case "managed-identity":
      return auth.clientId === undefined
        ? new identity.ManagedIdentityCredential()
        : new identity.ManagedIdentityCredential({ clientId: auth.clientId });
  }
}

export class AzureBlobObjectStorage implements ObjectStorage {
  private container?: Promise<{ sdk: typeof AzureSdk; client: AzureSdk.ContainerClient }>;

  constructor(
    private readonly config: AzureBlobObjectStorageConfig,
    private readonly idleBodyMs = IDLE_BODY_TIMEOUT_MS,
  ) {}

  /** The SDKs load on first use, so deployments without object storage never load them. */
  private connect() {
    this.container ??= Promise.all([
      import("@azure/storage-blob"),
      this.config.auth.kind === "account-key" ? undefined : import("@azure/identity"),
    ]).then(([sdk, identity]) => {
      const { account, auth, endpoint, container } = this.config;
      const url = endpoint ?? `https://${account}.blob.core.windows.net`;
      const service = new sdk.BlobServiceClient(
        url,
        auth.kind === "account-key"
          ? new sdk.StorageSharedKeyCredential(account, auth.accountKey)
          : tokenCredential(identity!, auth),
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
