import type { PageAbility, PageAppView, PageAskEvent, PageState } from "@rakazo/contracts";
import {
  PAGE_APP_API_PATH,
  PageAbilitiesSchema,
  PageAppViewSchema,
  PageAskEventSchema,
  PageImageSourceSchema,
} from "@rakazo/contracts";
import { PAGE_RUNTIME_PATH } from "@rakazo/core";

export type PageAppViewWithAbilities = PageAppView & {
  page: PageAppView["page"] & { abilities: PageAbility[] };
};

/** Tolerates a server that does not send the page's abilities yet: such a page uses none. */
function parseView(value: unknown): PageAppViewWithAbilities {
  const page = (value as { page?: Record<string, unknown> } | null)?.page;
  const abilities = PageAbilitiesSchema.parse(page?.abilities ?? []);
  const parsed = PageAppViewSchema.safeParse(value);
  const { abilities: _abilities, ...detail } = page ?? {};
  const view = parsed.success
    ? parsed.data
    : PageAppViewSchema.parse({ ...(value as object), page: detail });
  return { ...view, page: { ...view.page, abilities } };
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
    view: async (signal?: AbortSignal) => parseView(await json("", { signal })),
    image: async (imageId: string) =>
      PageImageSourceSchema.parse(await json(`/images/${encodeURIComponent(imageId)}`)).src,
    saveState: async (values: PageState) => {
      await json("/state", { method: "PUT", body: JSON.stringify({ values }) });
    },
    approve: async (abilities: PageAbility[]) => {
      const body = await json("/abilities", { method: "PUT", body: JSON.stringify({ abilities }) });
      return PageAbilitiesSchema.parse((body as { approved?: unknown }).approved);
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
    revoke: async () => {
      await request("", { method: "DELETE" });
    },
    runtime: async () => {
      const response = await fetcher(new URL(PAGE_RUNTIME_PATH, server));
      if (!response.ok) throw new PageAppRequestError(response.status);
      return response.text();
    },
  };
}

export type PageAppApi = ReturnType<typeof createPageAppApi>;
