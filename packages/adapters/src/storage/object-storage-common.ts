import { ClientError } from "@rakazo/core";

/** Upload part size: large enough that most homes are one request, small enough to hold in memory. */
export const PART_BYTES = 16 * 1024 * 1024;
/**
 * Parts of one object sent at once: enough to keep a slow link busy while each part waits on its
 * round trips. An upload holds about one part more than this in memory.
 */
export const PART_CONCURRENCY = 3;

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
  // Walk both ends: an unanchored /\/+$/ still backtracks quadratically on a slash run.
  const rawPrefix = env.OBJECT_STORAGE_PREFIX?.trim() ?? "";
  let start = 0;
  let end = rawPrefix.length;
  while (start < end && rawPrefix[start] === "/") start += 1;
  while (end > start && rawPrefix[end - 1] === "/") end -= 1;
  const prefix = rawPrefix.slice(start, end);
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

/**
 * Uploads `read`, then the rest of `source`, as parts numbered in stream order, with up to
 * `PART_CONCURRENCY` sending at once, and returns each upload's answer in part order whatever order
 * they finish in. After a failure no further part starts, and the first failure is thrown only once
 * the parts already sending have settled, so the caller can abort with nothing still in flight.
 */
export async function uploadParts<T>(
  read: readonly Buffer[],
  source: AsyncIterator<Buffer>,
  upload: (bytes: Buffer, partNumber: number) => Promise<T>,
): Promise<T[]> {
  const answers: T[] = [];
  const sending = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const start = (bytes: Buffer, partNumber: number) => {
    const sent: Promise<void> = upload(bytes, partNumber)
      .then(
        (answer) => {
          answers[partNumber - 1] = answer;
        },
        (error: unknown) => {
          failure ??= { error };
        },
      )
      .finally(() => sending.delete(sent));
    sending.add(sent);
  };
  try {
    for (let partNumber = 1; ; partNumber += 1) {
      while (sending.size >= PART_CONCURRENCY && !failure) await Promise.race(sending);
      if (failure) break;
      const next =
        partNumber <= read.length
          ? { done: false as const, value: read[partNumber - 1]! }
          : await source.next();
      if (next.done || failure) break;
      start(next.value, partNumber);
    }
  } finally {
    // A source that fails while parts are sending waits for them too.
    await Promise.all(sending);
  }
  if (failure) throw failure.error;
  return answers;
}
