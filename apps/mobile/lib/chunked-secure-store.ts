import * as SecureStore from "expo-secure-store";

const FORMAT = "rakazo.secure-chunks.v1";
// Some native Keychain versions reject values over 2 KB, including serialized accounts.
const CHUNK_BYTES = 1_500;
type Manifest = { format: typeof FORMAT; revision: string; count: number };
type Journal = Manifest & { previous: Manifest | null };
const operations = new Map<string, Promise<unknown>>();
let revisionSequence = 0;

function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const next = (operations.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  operations.set(key, next);
  return next.finally(() => {
    if (operations.get(key) === next) operations.delete(key);
  });
}

function manifest(raw: string | null): Manifest | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || !("format" in value) || value.format !== FORMAT)
    return null;
  const candidate = value as Partial<Manifest>;
  if (
    typeof candidate.revision !== "string" ||
    !/^[a-z0-9-]+$/.test(candidate.revision) ||
    !Number.isSafeInteger(candidate.count) ||
    candidate.count! < 1
  )
    throw new Error("Could not read secure storage");
  return candidate as Manifest;
}

function chunkKey(key: string, value: Manifest, index: number): string {
  return `${key}.chunks.${value.revision}.${index}`;
}

async function erase(key: string, value: Manifest): Promise<void> {
  await Promise.all(
    Array.from({ length: value.count }, (_, index) =>
      SecureStore.deleteItemAsync(chunkKey(key, value, index)),
    ),
  );
}

/** The journal survives process interruption before or after the manifest commit. */
async function recover(key: string): Promise<string | null> {
  const raw = await SecureStore.getItemAsync(key);
  const pending = await SecureStore.getItemAsync(`${key}.journal`);
  if (!pending) return raw;
  const transaction = manifest(pending);
  if (!transaction) throw new Error("Could not read secure storage");
  const previous = manifest(JSON.stringify((JSON.parse(pending) as Journal).previous));
  if (manifest(raw)?.revision === transaction.revision) {
    if (previous) await erase(key, previous);
  } else {
    await erase(key, transaction);
  }
  await SecureStore.deleteItemAsync(`${key}.journal`);
  return raw;
}

function chunks(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > CHUNK_BYTES) {
      result.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  result.push(current);
  return result;
}

/** Existing unchunked values remain readable until their next successful write. */
export function readChunkedSecureValue(key: string): Promise<string | null> {
  return serialized(key, async () => {
    const raw = await recover(key);
    const stored = manifest(raw);
    if (!stored) return raw;
    const values = await Promise.all(
      Array.from({ length: stored.count }, (_, index) =>
        SecureStore.getItemAsync(chunkKey(key, stored, index)),
      ),
    );
    if (values.some((value) => value === null)) throw new Error("Could not read secure storage");
    return values.join("");
  });
}

/** Publish only after every new chunk is durable; rejected writes preserve the old value. */
export function writeChunkedSecureValue(key: string, value: string): Promise<void> {
  return serialized(key, async () => {
    const previous = manifest(await recover(key));
    const values = chunks(value);
    const next: Manifest = {
      format: FORMAT,
      revision: `${Date.now().toString(36)}-${++revisionSequence}-${Math.random().toString(36).slice(2)}`,
      count: values.length,
    };
    try {
      await SecureStore.setItemAsync(`${key}.journal`, JSON.stringify({ ...next, previous }));
      for (const [index, chunk] of values.entries()) {
        await SecureStore.setItemAsync(chunkKey(key, next, index), chunk);
      }
      await SecureStore.setItemAsync(key, JSON.stringify(next));
    } catch (error) {
      await recover(key).catch(() => undefined);
      throw error;
    }
    // A committed value remains committed even if cleanup must wait for the next read.
    await recover(key).catch(() => undefined);
  });
}
