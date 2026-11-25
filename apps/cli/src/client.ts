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

/** The few calls the CLI makes, all under the server's `/api/v1` and authorized by the key. */
export function createClient(config: CliConfig, fetchImpl: typeof fetch = fetch) {
  assertSecureUrl(config.url);
  const base = `${config.url}/api/v1`;

  async function request(method: string, route: string, body?: unknown): Promise<Response> {
    const response = await fetchImpl(`${base}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${config.key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new ApiError(response.status, payload?.error?.message ?? response.statusText);
    }
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
      const response = await request("GET", `/tasks/${encodeURIComponent(id)}/events`);
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
      const response = await request("POST", "/chat/completions", {
        model: bot,
        stream: true,
        messages: [{ role: "user", content: message }],
      });
      if (!response.body) return;
      for await (const event of readEvents(response.body)) {
        if (event.data === "[DONE]") return;
        const chunk = JSON.parse(event.data) as {
          choices?: Array<{ delta?: { content?: string } }>;
          error?: { message?: string };
        };
        if (chunk.error) throw new ApiError(500, chunk.error.message ?? "The stream stopped");
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) yield content;
      }
      throw new ApiError(502, "The reply stopped before it finished");
    },
  };
}

export type Client = ReturnType<typeof createClient>;
