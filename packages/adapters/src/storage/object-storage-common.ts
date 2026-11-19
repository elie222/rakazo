import { ClientError } from "@rakazo/core";

/** Upload part size: large enough that most homes are one request, small enough to hold in memory. */
export const PART_BYTES = 16 * 1024 * 1024;

export interface ObjectStorageConnection {
  bucket: string;
  /** Service URL; empty uses the backend's default endpoint. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prepended to every key, so one bucket can hold several deployments. */
  prefix: string;
}

/** The store failed in a way that passes, such as an outage, throttling or a dropped connection. */
export class ObjectStorageUnavailableError extends ClientError {
  constructor(options?: ErrorOptions) {
    super(
      "SERVICE_UNAVAILABLE",
      "File storage is not responding. Try again in a moment.",
      "SERVICE_UNAVAILABLE",
      options,
    );
    this.name = "ObjectStorageUnavailableError";
  }
}

/**
 * The `OBJECT_STORAGE_*` settings every backend shares. `OBJECT_STORAGE_BUCKET` turns object
 * storage on. Credentials are required rather than taken from an SDK's default chain, so object
 * storage never borrows credentials configured for something else.
 */
export function objectStorageConnectionFromEnv(
  env: NodeJS.ProcessEnv,
): ObjectStorageConnection | undefined {
  const bucket = env.OBJECT_STORAGE_BUCKET?.trim();
  if (!bucket) return undefined;
  const accessKeyId = env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey)
    throw new Error(
      "OBJECT_STORAGE_ACCESS_KEY_ID and OBJECT_STORAGE_SECRET_ACCESS_KEY are required with OBJECT_STORAGE_BUCKET",
    );
  const endpoint = env.OBJECT_STORAGE_ENDPOINT?.trim() || undefined;
  if (endpoint && !/^https?:\/\//.test(endpoint))
    throw new Error("OBJECT_STORAGE_ENDPOINT must be an http(s) URL");
  const prefix = (env.OBJECT_STORAGE_PREFIX?.trim() ?? "").replace(/^\/+|\/+$/g, "");
  return { bucket, endpoint, accessKeyId, secretAccessKey, prefix: prefix ? `${prefix}/` : "" };
}

/** Regroups a stream into buffers of exactly `size` bytes, except a shorter last one. */
export async function* parts(
  source: AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Buffer> {
  let held: Buffer[] = [];
  let length = 0;
  for await (const chunk of source) {
    let rest = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    while (length + rest.length >= size) {
      const take = size - length;
      held.push(rest.subarray(0, take));
      yield Buffer.concat(held);
      held = [];
      length = 0;
      rest = rest.subarray(take);
    }
    if (rest.length) {
      // Copy: callers may reuse the buffers they yield.
      held.push(Buffer.from(rest));
      length += rest.length;
    }
  }
  if (length) yield Buffer.concat(held);
}
