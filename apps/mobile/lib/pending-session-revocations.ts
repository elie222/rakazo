import { readBoundedJsonResponse } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { fetchServer } from "./server-headers";

const INDEX_KEY = "rakazo.revocations";
type Entry = { id: string; apiBase: string };
type Revocation = Entry & { token: string };
let writes: Promise<unknown> = Promise.resolve();

const revocationKey = (id: string) => `rakazo.revocation.${id}`;

async function read(): Promise<Revocation[]> {
  const raw = await SecureStore.getItemAsync(INDEX_KEY);
  let entries: unknown = null;
  try {
    entries = raw ? JSON.parse(raw) : [];
  } catch {
    entries = null;
  }
  if (
    !Array.isArray(entries) ||
    !entries.every(
      (entry) =>
        typeof entry?.id === "string" &&
        /^[a-z0-9-]+$/.test(entry.id) &&
        typeof entry.apiBase === "string",
    )
  ) {
    // An unreadable queue cannot be repaired; its sign-outs simply are not retried.
    await SecureStore.deleteItemAsync(INDEX_KEY).catch(() => undefined);
    return [];
  }
  const rows = await Promise.all(
    (entries as Entry[]).map(async (entry) => ({
      ...entry,
      token: (await SecureStore.getItemAsync(revocationKey(entry.id))) ?? "",
    })),
  );
  const valid = rows.filter((row) => row.token);
  if (valid.length !== rows.length) await writeIndex(valid);
  return valid;
}

async function writeIndex(rows: Revocation[]): Promise<void> {
  await SecureStore.setItemAsync(
    INDEX_KEY,
    JSON.stringify(rows.map(({ id, apiBase }) => ({ id, apiBase }))),
  );
}

function serialized(task: () => Promise<void>): Promise<void> {
  const next = writes.catch(() => undefined).then(task);
  writes = next;
  return next;
}

/** Revocation-only credentials never belong in account menus or content requests. */
export function queueSessionRevocation(apiBase: string, token: string): Promise<void> {
  if (!token) return Promise.resolve();
  return serialized(async () => {
    const rows = await read();
    if (rows.some((row) => row.apiBase === apiBase && row.token === token)) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    await SecureStore.setItemAsync(revocationKey(id), token);
    await writeIndex([...rows, { id, apiBase, token }]);
  });
}

export function completeSessionRevocation(apiBase: string, token: string): Promise<void> {
  return serialized(async () => {
    const rows = await read();
    const done = rows.filter((row) => row.apiBase === apiBase && row.token === token);
    if (!done.length) return;
    await writeIndex(rows.filter((row) => !done.includes(row)));
    await Promise.all(done.map((row) => SecureStore.deleteItemAsync(revocationKey(row.id)))).catch(
      () => undefined,
    );
  });
}

export async function pendingSessionTokens(apiBase: string): Promise<Set<string>> {
  await writes.catch(() => undefined);
  return new Set((await read()).filter((row) => row.apiBase === apiBase).map((row) => row.token));
}

/** Retry only on the configured server; never follow a redirect with a saved bearer. */
export async function retryPendingSessionRevocations(apiBase: string): Promise<void> {
  const tokens = await pendingSessionTokens(apiBase);
  await Promise.all(
    [...tokens].map(async (token) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetchServer(
          `${apiBase}/api/auth/sign-out`,
          {
            method: "POST",
            credentials: "omit",
            redirect: "error",
            headers: {
              origin: "rakazo://",
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: "{}",
            signal: controller.signal,
          },
          apiBase,
        );
        const body = await readBoundedJsonResponse<{ success?: unknown }>(
          response,
          8 * 1024,
          controller.signal,
        );
        if (response.ok && body?.success === true) await completeSessionRevocation(apiBase, token);
      } catch {
        // Retain only the revocation tombstone until the server is reachable again.
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
