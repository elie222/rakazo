import {
  type ServerUpdateRun,
  ServerUpdateRunSchema,
  type ServerUpdateStrategy,
} from "@rakazo/contracts";

/** The sidecar declined to act and said why; the caller should surface the reason verbatim. */
export class UpdaterRefused extends Error {}
/** The sidecar is not answering, which for a Compose deployment means updates are unavailable. */
export class UpdaterUnreachable extends Error {}

export interface UpdaterCheckout {
  present: boolean;
  commit: string | null;
  branch: string | null;
  remoteUrl: string | null;
  dirty: boolean;
  dirtyPaths: string[];
}

export interface UpdaterState {
  deployDir: string;
  composeFile: string;
  image: string;
  imageRef: string;
  running: boolean;
  currentTag: string;
  previousTag: string | null;
  checkout: UpdaterCheckout;
}

export interface UpdaterPlan {
  strategy: Exclude<ServerUpdateStrategy, "checkout">;
  reason: string;
  currentTag: string;
  previousTag: string | null;
  targetTag: string | null;
  targetCommit: string | null;
  upToDate: boolean;
  checkout: UpdaterCheckout;
}

export interface UpdaterRequest {
  repoUrl: string;
  branch: string;
}

export interface UpdaterClient {
  state: () => Promise<UpdaterState>;
  plan: (request: UpdaterRequest) => Promise<UpdaterPlan>;
  apply: (request: UpdaterRequest) => Promise<ServerUpdateRun>;
  rollback: () => Promise<ServerUpdateRun>;
}

export interface UpdaterClientOptions {
  url: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  /** A fork build recreates images, which is minutes; a read is seconds. */
  readTimeoutMs?: number;
  applyTimeoutMs?: number;
}

const READ_TIMEOUT_MS = 60_000;
const APPLY_TIMEOUT_MS = 45 * 60_000;

export function createUpdaterClient(options: UpdaterClientOptions): UpdaterClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = options.url.replace(/\/$/, "");

  async function call<T>(
    pathname: string,
    init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${pathname}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch (error) {
      throw new UpdaterUnreachable(
        `The updater sidecar at ${base} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === 400) {
      throw new UpdaterRefused(payload.error ?? "The updater refused this update.");
    }
    if (!response.ok) {
      throw new UpdaterUnreachable(
        payload.error ?? `The updater sidecar answered ${response.status}.`,
      );
    }
    return payload as T;
  }

  return {
    state: () =>
      call<UpdaterState>("/state", {
        method: "GET",
        timeoutMs: options.readTimeoutMs ?? READ_TIMEOUT_MS,
      }),
    plan: (request) =>
      call<UpdaterPlan>("/plan", {
        method: "POST",
        body: request,
        timeoutMs: options.readTimeoutMs ?? READ_TIMEOUT_MS,
      }),
    apply: async (request) =>
      ServerUpdateRunSchema.parse(
        await call<unknown>("/apply", {
          method: "POST",
          body: request,
          timeoutMs: options.applyTimeoutMs ?? APPLY_TIMEOUT_MS,
        }),
      ),
    rollback: async () =>
      ServerUpdateRunSchema.parse(
        await call<unknown>("/rollback", {
          method: "POST",
          timeoutMs: options.applyTimeoutMs ?? APPLY_TIMEOUT_MS,
        }),
      ),
  };
}
