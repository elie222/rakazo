import { readBoundedJsonResponse } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { fetchServer } from "./server-headers";

const KEY = "rakazo.pending_session_revocations";
type Revocation = { apiBase: string; token: string };
let writes: Promise<unknown> = Promise.resolve();

async function read(): Promise<Revocation[]> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return [];
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error("Could not read pending sign-outs");
  return rows.filter((row): row is Revocation =>
    Boolean(
      row &&
        typeof row.apiBase === "string" &&
        row.apiBase &&
        typeof row.token === "string" &&
        row.token,
    ),
  );
}

function update(change: (rows: Revocation[]) => Revocation[]): Promise<void> {
  const next = writes
    .catch(() => undefined)
    .then(async () => {
      await SecureStore.setItemAsync(KEY, JSON.stringify(change(await read())));
    });
  writes = next;
  return next;
}

/** Revocation-only credentials never belong in account menus or content requests. */
export function queueSessionRevocation(apiBase: string, token: string): Promise<void> {
  if (!token) return Promise.resolve();
  return update((rows) =>
    rows.some((row) => row.apiBase === apiBase && row.token === token)
      ? rows
      : [...rows, { apiBase, token }],
  );
}

export function completeSessionRevocation(apiBase: string, token: string): Promise<void> {
  return update((rows) => rows.filter((row) => row.apiBase !== apiBase || row.token !== token));
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
