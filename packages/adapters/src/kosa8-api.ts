import { parseRetryAfter } from "@rakazo/core";

/** kosa8 Cloud's own API, used directly: no SDK to load. */
export const KOSA8_DEFAULT_API_URL = "https://api.kosa8.com";

export type Kosa8SandboxState =
  | "creating"
  | "running"
  | "sleeping"
  | "stopped"
  | "error"
  | "deleted"
  | (string & {});

export interface Kosa8Sandbox {
  id: string;
  state: Kosa8SandboxState;
}

export interface Kosa8Snapshot {
  id: string;
  name: string | null;
  state: "ready" | "creating" | "deleted" | "error" | (string & {});
}

export interface Kosa8ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Kosa8CreateRequest {
  /** A template's warm pool, such as `universal-4x8`. */
  template?: string;
  /** A snapshot id; the sandbox takes its size and settings from the snapshot. */
  snapshot?: string;
  name: string;
  labels: Record<string, string>;
  /** Idle seconds before kosa8 puts the sandbox to sleep with its memory; 0 never. */
  sleepAfterS: number;
}

/** The kosa8 Cloud calls the adapter makes; tests pass an in-memory stand-in. */
export interface Kosa8Api {
  create(request: Kosa8CreateRequest): Promise<Kosa8Sandbox>;
  get(id: string): Promise<Kosa8Sandbox>;
  sleep(id: string): Promise<void>;
  wake(id: string): Promise<void>;
  /** False when the sandbox was already gone. */
  delete(id: string, timeoutMs?: number): Promise<boolean>;
  /**
   * Runs `script` with bash in the sandbox's one long-lived container and resolves once it exits.
   * Aborting only stops listening; the caller ends the process itself.
   */
  exec(
    id: string,
    script: string,
    options: { env: Record<string, string>; signal?: AbortSignal },
  ): Promise<Kosa8ExecResult>;
  /** Paths under /workspace only. */
  readFile(id: string, path: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** Paths under /workspace only; missing directories are made. */
  writeFile(id: string, path: string, data: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** A public HTTPS host for `port`, WebSockets included. Asking again returns the same one. */
  publish(id: string, port: number): Promise<{ host: string }>;
  snapshot(id: string, name: string): Promise<Kosa8Snapshot>;
  snapshots(): Promise<Kosa8Snapshot[]>;
  deleteSnapshot(id: string): Promise<void>;
}

/** A refusal from the kosa8 API, with its HTTP status and stable error code. */
export class Kosa8ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "Kosa8ApiError";
  }
}

/** Each stream holds at most this much; the rest of a long output is dropped from its middle. */
const MAX_STREAM_BYTES = 1024 ** 2;
/** Bounds each control-plane request; exec and file transfers run as long as they need. */
const REQUEST_TIMEOUT_MS = 60_000;

export function nativeKosa8Api(
  apiKey: string,
  apiUrl = KOSA8_DEFAULT_API_URL,
  fetcher: typeof fetch = fetch,
): Kosa8Api {
  const base = apiUrl.replace(/\/+$/, "");
  const send = async (
    method: string,
    path: string,
    init: { json?: unknown; body?: Uint8Array; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      "user-agent": "rakazo-kosa8-adapter",
    };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.body) {
      headers["content-type"] = "application/octet-stream";
      // A copy owned by this request, as fetch takes ArrayBuffer-backed views only.
      body = new Uint8Array(init.body);
    }
    const signals = [init.signal, init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined];
    const response = await fetcher(`${base}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.any(signals.filter((signal): signal is AbortSignal => !!signal)),
    });
    if (!response.ok) throw await apiError(response);
    return response;
  };
  const json = async <T>(
    method: string,
    path: string,
    payload?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> =>
    (await (
      await send(method, path, { ...(payload === undefined ? {} : { json: payload }), timeoutMs })
    ).json()) as T;
  const sandbox = (id: string) => `/v1/sandboxes/${encodeURIComponent(id)}`;
  const file = (id: string, path: string) =>
    `${sandbox(id)}/files/raw?path=${encodeURIComponent(path)}`;
  return {
    create: async (request) =>
      (
        await json<{ sandbox: Kosa8Sandbox }>("POST", "/v1/sandboxes", {
          ...(request.snapshot ? { snapshot: request.snapshot } : { persistent: true }),
          ...(request.template ? { template: request.template } : {}),
          name: request.name,
          labels: request.labels,
          sleep_after_s: request.sleepAfterS,
        })
      ).sandbox,
    get: async (id) => (await json<{ sandbox: Kosa8Sandbox }>("GET", sandbox(id))).sandbox,
    sleep: async (id) => {
      await json("POST", `${sandbox(id)}/sleep`);
    },
    wake: async (id) => {
      await json("POST", `${sandbox(id)}/wake`);
    },
    delete: async (id, timeoutMs) => {
      try {
        await json("DELETE", sandbox(id), undefined, timeoutMs);
        return true;
      } catch (error) {
        if (error instanceof Kosa8ApiError && error.status === 404) return false;
        throw error;
      }
    },
    exec: async (id, script, options) => {
      const response = await send("POST", `${sandbox(id)}/exec`, {
        json: {
          cmd: ["bash", "-c", script],
          env: Object.entries(options.env).map(([name, value]) => `${name}=${value}`),
          stream: true,
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return readExecStream(response);
    },
    readFile: async (id, path, signal) =>
      new Uint8Array(
        await (await send("GET", file(id, path), signal ? { signal } : {})).arrayBuffer(),
      ),
    writeFile: async (id, path, data, signal) => {
      await (
        await send("PUT", file(id, path), { body: data, ...(signal ? { signal } : {}) })
      ).body?.cancel();
    },
    publish: async (id, port) => {
      const answer = await json<{ preview?: { host: string }; host?: string }>(
        "POST",
        `${sandbox(id)}/previews`,
        { port, public: true },
      );
      const host = answer.preview?.host ?? answer.host;
      if (!host) throw new Error(`kosa8 did not return a public address for port ${port}`);
      return { host };
    },
    snapshot: async (id, name) =>
      (await json<{ snapshot: Kosa8Snapshot }>("POST", `${sandbox(id)}/snapshots`, { name }))
        .snapshot,
    snapshots: async () =>
      (await json<{ snapshots: Kosa8Snapshot[] }>("GET", "/v1/snapshots")).snapshots,
    deleteSnapshot: async (id) => {
      await json("DELETE", `/v1/snapshots/${encodeURIComponent(id)}`);
    },
  };
}

async function apiError(response: Response): Promise<Kosa8ApiError> {
  const text = await response.text();
  let code = "http_error";
  let message = text.slice(0, 500) || `HTTP ${response.status}`;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string") code = body.error;
    if (typeof body.message === "string") message = body.message;
  } catch {
    // A proxy's own error page: its text is the message.
  }
  return new Kosa8ApiError(
    response.status,
    code,
    `kosa8: ${message}`,
    parseRetryAfter(response.headers.get("retry-after")),
  );
}

/** Newline-delimited frames: `{stream, data}` in base64, then `{done, exit}` or `{done, error}`. */
export async function readExecStream(response: Response): Promise<Kosa8ExecResult> {
  const out = { stdout: new BoundedText(), stderr: new BoundedText() };
  const decoder = new TextDecoder();
  let pending = "";
  const reader = response.body?.getReader();
  if (!reader) throw new Error("kosa8 sent no command output");
  for (;;) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line) as {
        stream?: string;
        data?: string;
        done?: boolean;
        exit?: number;
        error?: string;
      };
      if (frame.done) {
        await reader.cancel();
        if (typeof frame.exit === "number")
          return { exitCode: frame.exit, stdout: out.stdout.text(), stderr: out.stderr.text() };
        throw new Error(`kosa8 command failed: ${frame.error ?? "no exit status"}`);
      }
      if (frame.data && (frame.stream === "stdout" || frame.stream === "stderr"))
        out[frame.stream].add(Buffer.from(frame.data, "base64"));
    }
    if (done) throw new Error("kosa8 command output ended before the command exited");
  }
}

/** Keeps the start and end of a stream past MAX_STREAM_BYTES, as the buffered SDKs do. */
class BoundedText {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = false;

  add(chunk: Buffer): void {
    const room = MAX_STREAM_BYTES / 2 - this.headBytes;
    if (room > 0) {
      const kept = chunk.subarray(0, room);
      this.head.push(kept);
      this.headBytes += kept.byteLength;
      chunk = chunk.subarray(kept.byteLength);
    }
    if (!chunk.byteLength) return;
    this.tail.push(chunk);
    this.tailBytes += chunk.byteLength;
    while (this.tailBytes > MAX_STREAM_BYTES / 2 && this.tail.length) {
      const first = this.tail[0]!;
      const excess = this.tailBytes - MAX_STREAM_BYTES / 2;
      this.dropped = true;
      if (first.byteLength <= excess) {
        this.tail.shift();
        this.tailBytes -= first.byteLength;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
      }
    }
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    return this.dropped ? `${head}\n[output truncated]\n${tail}` : head + tail;
  }
}
