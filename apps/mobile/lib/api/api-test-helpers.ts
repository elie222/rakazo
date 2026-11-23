import * as SecureStore from "expo-secure-store";
import { vi } from "vitest";
import type { MobileMessage, MobileSnapshot } from "./mobile-types.js";

/** Shared fixtures for the mobile API tests. */
export function mockSecureStore(store: Map<string, string>) {
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => store.get(key) ?? null);
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    store.delete(key);
  });
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    store.set(key, value);
  });
}

export function pendingSignOutRecords(
  store: Map<string, string>,
): { apiBase: string; token: string }[] {
  const raw = store.get("rakazo.pending_sign_out");
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is { apiBase: string; token: string } => {
      if (!entry || typeof entry !== "object") return false;
      const record = entry as { apiBase?: unknown; token?: unknown };
      return typeof record.apiBase === "string" && typeof record.token === "string";
    })
    .map((record) => ({ apiBase: record.apiBase, token: record.token }));
}

export function deferredFetch() {
  let resolveFetch: (response: Response) => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const fetchStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolveResponse) => {
        resolveFetch = resolveResponse;
        markStarted();
      }),
  );
  return {
    fetchMock,
    fetchStarted,
    resolveFetch: (response: Response) => resolveFetch(response),
  };
}

export function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A failed procedure as the oRPC server sends it. */
export function rpcErrorResponse(status: number, code: string, message: string) {
  return jsonResponse({ json: { defined: false, code, status, message } }, { status });
}

export function paddedThreadFrame(bytes: number, seq: number) {
  const suffix = new TextEncoder().encode(
    `\ndata: ${JSON.stringify({ json: { type: "thread.progress", seq } })}\n\n`,
  );
  const frame = new Uint8Array(bytes).fill(120);
  frame[0] = 58;
  frame.set(suffix, bytes - suffix.byteLength);
  return frame;
}

export function snapshot(
  messages: MobileMessage[] = [],
  olderCursor: number | null = null,
): MobileSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 3,
    messages,
    olderCursor,
    run: null,
    computer: {
      state: "running",
      controlHolder: "bot",
      screenAvailable: true,
      mode: "team",
      busyBotName: null,
    },
  };
}

export function mobileMessage(
  id: string,
  blocks: MobileMessage["blocks"],
  seq?: number,
): MobileMessage {
  return { id, threadId: "thread-1", seq, role: "bot", blocks };
}
