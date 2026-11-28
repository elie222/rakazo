import type { PublicTask } from "@rakazo/contracts";
import type { CliConfig } from "./config.js";
import { readEvents } from "./sse.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The key is a bearer credential, so it only travels over HTTPS, or to this machine. */
export function assertSecureUrl(url: string): void {
  const parsed = URL.parse(url);
  if (!parsed) throw new Error(`Not a URL: ${url}`);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local))
    throw new Error("Use an https:// address; only this machine may use http://");
}

type Model = { id: string; name: string; owned_by: string };

/**
 * The server's own message when it sent one. A proxy or an HTML error page answers instead when
 * the API is unreachable, so the status text is the fallback and an unreadable body is not an error.
 */
async function errorMessage(response: Response): Promise<string> {
  try {
    // A connection that drops mid-body is the same case as a body that is not JSON: the status
    // is all the server told us, so it is what the CLI reports.
    const body = await response.text();
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

/** The few calls the CLI makes, all under the server's `/api/v1` and authorized by the key. */
export function createClient(config: CliConfig, fetchImpl: typeof fetch = fetch) {
  assertSecureUrl(config.url);
  const base = `${config.url}/api/v1`;

  async function request(
    method: string,
    route: string,
    body?: unknown,
    stream = false,
  ): Promise<Response> {
    const response = await fetchImpl(`${base}${route}`, {
      method,
      // A redirect could carry the key or the message to another host.
      redirect: "error",
      headers: {
        authorization: `Bearer ${config.key}`,
        // Says it is a stream, so a server shutting down closes it at once rather than waiting.
        ...(stream ? { accept: "text/event-stream" } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
    return response;
  }

  const json = async <T>(method: string, route: string, body?: unknown) =>
    (await (await request(method, route, body)).json()) as T;

  return {
    bots: async () => (await json<{ data: Model[] }>("GET", "/models")).data,
    createTask: (input: { bot: string; input: string; callback_url?: string }) =>
      json<PublicTask & { callback_secret?: string }>("POST", "/tasks", input),
    task: (id: string) => json<PublicTask>("GET", `/tasks/${encodeURIComponent(id)}`),
    sendToTask: (id: string, input: string) =>
      json<PublicTask>("POST", `/tasks/${encodeURIComponent(id)}/messages`, { input }),
    /** The task each time it changes, until it settles. */
    async *followTask(id: string): AsyncGenerator<PublicTask> {
      const response = await request(
        "GET",
        `/tasks/${encodeURIComponent(id)}/events`,
        undefined,
        true,
      );
      if (!response.body) return;
      for await (const event of readEvents(response.body)) {
        if (event.event === "task") yield JSON.parse(event.data) as PublicTask;
        if (event.event === "error") {
          const { error } = JSON.parse(event.data) as {
            error?: { status?: number; message?: string };
          };
          throw new ApiError(error?.status ?? 500, error?.message ?? "The stream stopped");
        }
      }
    },
    /** A chat turn's reply as it arrives. */
    async *chat(bot: string, message: string): AsyncGenerator<string> {
      const response = await request(
        "POST",
        "/chat/completions",
        { model: bot, stream: true, messages: [{ role: "user", content: message }] },
        true,
      );
      if (!response.body) return;
      for await (const event of readEvents(response.body)) {
        if (event.data === "[DONE]") return;
        const chunk = JSON.parse(event.data) as {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          error?: { message?: string };
        };
        if (chunk.error) throw new ApiError(500, chunk.error.message ?? "The stream stopped");
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) yield content;
        if (chunk.choices?.[0]?.finish_reason === "length")
          throw new ApiError(504, "The bot is still working; follow the task for the rest");
      }
      throw new ApiError(502, "The reply stopped before it finished");
    },
  };
}

export type Client = ReturnType<typeof createClient>;
