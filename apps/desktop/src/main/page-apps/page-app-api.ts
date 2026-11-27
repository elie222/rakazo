import type { PageAbility, PageAppView, PageAskEvent, PageState } from "@rakazo/contracts";
import {
  knownPageAbilities,
  PAGE_APP_API_PATH,
  PageAppViewSchema,
  PageAskEventSchema,
  PageDetailSchema,
  PageIconColorSchema,
  PageImageSourceSchema,
} from "@rakazo/contracts";
import { deadlineSignal, PAGE_RUNTIME_PATH } from "@rakazo/core";

const REVOKE_DEADLINE_MS = 15_000;

import { getLogger } from "@rakazo/logging";

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/**
 * The view as this app reads it. An app is a copy of the Rakazo that made it and can trail the
 * server, so what a newer server adds (a field, an ability, an icon color) is left out, not refused.
 */
export function readPageAppView(value: unknown): PageAppView {
  const raw = (value ?? {}) as { appId?: unknown; approved?: unknown; page?: unknown };
  const sent = (raw.page ?? {}) as Record<string, unknown>;
  const page = Object.fromEntries(
    Object.keys(PageDetailSchema.shape).flatMap((key) => (key in sent ? [[key, sent[key]]] : [])),
  );
  page.abilities = knownPageAbilities(strings(sent.abilities));
  if (!PageIconColorSchema.safeParse(page.iconColor).success) page.iconColor = null;
  return PageAppViewSchema.parse({
    appId: raw.appId,
    approved: knownPageAbilities(strings(raw.approved)),
    page,
  });
}

/** A refused or failed request; 401 means the app's token no longer works. */
export class PageAppRequestError extends Error {
  constructor(readonly status: number) {
    super(`Page app request failed with HTTP ${status}.`);
  }
}

type Fetch = typeof fetch;

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let end = buffered.indexOf("\n");
    while (end !== -1) {
      yield buffered.slice(0, end).replace(/\r$/, "");
      buffered = buffered.slice(end + 1);
      end = buffered.indexOf("\n");
    }
  }
  if (buffered) yield buffered;
}

/** The installed app's side of the page app API, with its own token. */
export function createPageAppApi(server: string, token: string, fetcher: Fetch = fetch) {
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetcher(new URL(`${PAGE_APP_API_PATH}${path}`, server), {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PageAppRequestError(response.status);
    }
    return response;
  }
  const json = (path: string, init?: RequestInit) =>
    request(path, init).then((response) => response.json() as Promise<unknown>);

  return {
    view: async (signal?: AbortSignal) => readPageAppView(await json("", { signal })),
    image: async (imageId: string, version: number) =>
      PageImageSourceSchema.parse(
        await json(`/images/${encodeURIComponent(imageId)}?version=${version}`),
      ).src,
    saveState: async (values: PageState) => {
      await json("/state", { method: "PUT", body: JSON.stringify({ values }) });
    },
    approve: async (abilities: PageAbility[]) => {
      const body = await json("/abilities", { method: "PUT", body: JSON.stringify({ abilities }) });
      return knownPageAbilities(strings((body as { approved?: unknown }).approved));
    },
    /** The bot's progress on one question, until its answer or failure. */
    ask: async function* (
      text: string,
      clientNonce: string,
      signal?: AbortSignal,
    ): AsyncGenerator<PageAskEvent> {
      const response = await request("/ask", {
        method: "POST",
        body: JSON.stringify({ text, clientNonce }),
        signal,
      });
      if (!response.body) return;
      for await (const line of lines(response.body)) {
        if (line.trim()) yield PageAskEventSchema.parse(JSON.parse(line));
      }
    },
    /** Resolves each time the page changes, until the stream ends. */
    changes: async function* (signal: AbortSignal): AsyncGenerator<void> {
      const response = await request("/changes", { signal });
      if (!response.body) return;
      for await (const line of lines(response.body)) {
        if (line.startsWith("data:")) yield;
      }
    },
    revoke: async (signal?: AbortSignal) => {
      await request("", { method: "DELETE", signal });
    },
    runtime: async () => {
      const response = await fetcher(new URL(PAGE_RUNTIME_PATH, server));
      if (!response.ok) throw new PageAppRequestError(response.status);
      return response.text();
    },
  };
}

export type PageAppApi = ReturnType<typeof createPageAppApi>;

/**
 * Ends an app's token, true once the server no longer takes it. A failure keeps the token, so
 * whoever holds it can try again rather than leave it working with nothing to end it.
 */
export async function revokePageAppToken(api: PageAppApi): Promise<boolean> {
  try {
    await api.revoke(deadlineSignal(REVOKE_DEADLINE_MS));
    return true;
  } catch (error) {
    if (error instanceof PageAppRequestError && (error.status === 401 || error.status === 404))
      return true;
    getLogger().warn("page app revoke failed", { error });
    return false;
  }
}
