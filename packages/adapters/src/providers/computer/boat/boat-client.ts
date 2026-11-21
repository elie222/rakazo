import type { BoatApi } from "@boatdev/sdk";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import { abortableDelay, deadlineSignal } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { sandboxNotFoundError } from "../../../computers/sandbox/sandbox-errors.js";
import { withAbort } from "../../../web/web-ssrf.js";
import {
  BoatApiError,
  BoatRequestGate,
  boatResponseError,
  boatResumeInProgress,
  boatSdk,
  callerSignal,
  wrapBoatCall,
} from "./boat-errors.js";

const BOAT_API_BASE = "https://boat.dev/api/v1";
/**
 * Status polls start fast so short waits stay quick, then slow to this. Every Boat request from
 * this host counts against one per-IP budget.
 */
const BOAT_POLL_MAX_MS = 5_000;
const BOAT_DELETE_TIMEOUT_MS = 60_000;
export const BOAT_GONE_CHECK_TIMEOUT_MS = 10_000;
/**
 * Without these, a call Boat never answers waits out Node's five-minute header timeout. Resumes
 * usually answer within seconds; a slow one that is cut off keeps going, and the next resume
 * waits on it.
 */
const BOAT_GET_TIMEOUT_MS = 60_000;
const BOAT_RESUME_TIMEOUT_MS = 2 * 60_000;

const BOAT_API_METHODS = [
  "artifactRaw",
  "attachCommandRaw",
  "command",
  "commandStatus",
  "create",
  "createDownloadUrl",
  "createUploadUrl",
  "get",
  "getLatestSandboxSnapshot",
  "getSavedSnapshot",
  "getSnapshotFileRaw",
  "getStop",
  "hostPort",
  "recover",
  "resume",
  "saveSavedSnapshot",
  "stop",
  "update",
  "writeFile",
] as const;

/** The Boat API surface the adapter uses. Failures are the SDK's raw `ResponseError`s. */
export type BoatSandboxSdk = Pick<BoatApi, (typeof BOAT_API_METHODS)[number]> & {
  /** Resolves once the sandbox no longer exists, including when it never did. */
  deleteSandbox(sandboxId: string, init?: { signal?: AbortSignal }): Promise<void>;
};

export function createBoatClient(
  config: { apiKey: string; apiUrl?: string },
  api?: BoatSandboxSdk,
): BoatSandboxSdk {
  const gate = new BoatRequestGate();
  return boatClient(api ?? createBoatSdk(config, gate), config.apiKey, gate);
}

/** Boat deletes a stopped sandbox's data after 14 days but keeps the record; it cannot resume. */
/** Named so the shared `isSandboxGoneError` lets callers replace it from its last checkpoint. */
export function boatSandboxGone(sandboxId: string, cause?: unknown): Error {
  return sandboxNotFoundError(`Boat sandbox ${sandboxId} is gone`, { cause });
}

/** Turns raw SDK failures into actionable errors, rate limits, and gone sandboxes. */
function boatClient(api: BoatSandboxSdk, apiKey: string, gate: BoatRequestGate): BoatSandboxSdk {
  const boatCall = <Args extends unknown[], Result>(
    call: (...args: Args) => Promise<Result>,
    idempotent = false,
    timeoutMs?: number,
  ) => wrapBoatCall(call, apiKey, idempotent, gate, timeoutMs);
  const get = boatCall(api.get.bind(api), true, BOAT_GET_TIMEOUT_MS);
  const sandboxCall = <Args extends [{ sandboxId: string }, ...unknown[]], Result>(
    call: (...args: Args) => Promise<Result>,
    idempotent = false,
    timeoutMs?: number,
  ) => {
    const wrapped = boatCall(call, idempotent, timeoutMs);
    return async (...args: Args): Promise<Result> => {
      try {
        return await wrapped(...args);
      } catch (error) {
        const { sandboxId } = args[0];
        if (!(error instanceof BoatApiError)) throw error;
        // Boat keeps the record of a sandbox whose snapshot data it deleted, but cannot resume it.
        // A 404 can mean a missing file in a live sandbox; only a missing sandbox counts as gone.
        if (
          error.code === "snapshot_data_expired" ||
          (error.response.status === 404 &&
            (await sandboxMissing(get, sandboxId, callerSignal(args[1]))))
        ) {
          throw boatSandboxGone(sandboxId, error);
        }
        throw error;
      }
    };
  };
  // Observe the provider call itself: provisioning can succeed while later setup fails,
  // and background probes or file operations can resume a provider-expired computer too.
  const startCall =
    <Args extends unknown[], Result>(
      operation: "create" | "resume" | "recover",
      call: (...args: Args) => Promise<Result>,
    ) =>
    async (...args: Args): Promise<Result> => {
      const started = performance.now();
      try {
        const result = await call(...args);
        getLogger().info("sandbox.start", {
          provider: "boat",
          operation,
          outcome: "accepted",
          durationMs: Math.round(performance.now() - started),
        });
        return result;
      } catch (error) {
        const durationMs = Math.round(performance.now() - started);
        // Another caller's resume is already waking it; the caller waits for it to be ready.
        if (boatResumeInProgress(error)) {
          getLogger().info("sandbox.start", {
            provider: "boat",
            operation,
            outcome: "in_progress",
            durationMs,
          });
          throw error;
        }
        getLogger().warn("sandbox.start", {
          provider: "boat",
          operation,
          outcome: error instanceof SandboxRateLimitError ? "rate_limited" : "failed",
          durationMs,
          error,
        });
        throw error;
      }
    };
  // Reads, URL grants, TTL updates, and whole-file writes are safe to send twice.
  return {
    artifactRaw: sandboxCall(api.artifactRaw.bind(api), true),
    attachCommandRaw: sandboxCall(api.attachCommandRaw.bind(api), true),
    command: sandboxCall(api.command.bind(api)),
    commandStatus: sandboxCall(api.commandStatus.bind(api), true),
    create: startCall("create", boatCall(api.create.bind(api))),
    createDownloadUrl: sandboxCall(api.createDownloadUrl.bind(api), true),
    createUploadUrl: sandboxCall(api.createUploadUrl.bind(api), true),
    get: sandboxCall(api.get.bind(api), true, BOAT_GET_TIMEOUT_MS),
    getLatestSandboxSnapshot: boatCall(api.getLatestSandboxSnapshot.bind(api), true),
    getSavedSnapshot: boatCall(api.getSavedSnapshot.bind(api), true),
    getSnapshotFileRaw: boatCall(api.getSnapshotFileRaw.bind(api), true),
    getStop: boatCall(api.getStop.bind(api), true),
    hostPort: sandboxCall(api.hostPort.bind(api), true),
    recover: startCall("recover", sandboxCall(api.recover.bind(api))),
    resume: startCall("resume", sandboxCall(api.resume.bind(api), true, BOAT_RESUME_TIMEOUT_MS)),
    saveSavedSnapshot: boatCall(api.saveSavedSnapshot.bind(api)),
    stop: sandboxCall(api.stop.bind(api)),
    update: sandboxCall(api.update.bind(api), true),
    writeFile: sandboxCall(api.writeFile.bind(api), true),
    deleteSandbox: boatCall(api.deleteSandbox.bind(api)),
  };
}

function createBoatSdk(
  config: { apiKey: string; apiUrl?: string },
  gate: BoatRequestGate,
): BoatSandboxSdk {
  const apiUrl = (config.apiUrl ?? BOAT_API_BASE).replace(/\/$/, "");
  // The SDK loads on the first call, so a process without Boat configured never loads it.
  let api: Promise<BoatApi> | undefined;
  const loadApi = () =>
    (api ??= boatSdk().then(
      ({ BoatApi, Configuration }) =>
        new BoatApi(
          new Configuration({
            basePath: apiUrl,
            accessToken: config.apiKey,
            // The SDK defaults to its own HTTP/2 client; keep requests on the runtime fetch.
            fetchApi: (input, init) => fetch(input, init),
          }),
        ),
    ));
  const methods = Object.fromEntries(
    BOAT_API_METHODS.map((name) => [
      name,
      async (...args: unknown[]) => {
        const loaded = await loadApi();
        return (loaded[name] as (...args: unknown[]) => unknown).apply(loaded, args);
      },
    ]),
  ) as Pick<BoatApi, (typeof BOAT_API_METHODS)[number]>;
  return Object.assign(methods, {
    deleteSandbox: async (sandboxId: string, init?: { signal?: AbortSignal }) => {
      const url = `${apiUrl}/sandboxes/${encodeURIComponent(sandboxId)}`;
      const headers = { Authorization: `Bearer ${config.apiKey}` };
      const signal = deadlineSignal(BOAT_DELETE_TIMEOUT_MS, init?.signal);
      try {
        await withAbort(gate.wait(signal), signal);
        const response = await fetch(url, {
          method: "DELETE",
          headers: {
            ...headers,
            "X-Ascii-Confirm-Delete": sandboxId,
          },
          signal,
        });
        if (response.status === 404) return;
        if (!response.ok) {
          throw await boatResponseError(response, config.apiKey, signal);
        }
        for (let pause = 500; !signal.aborted; pause = nextPoll(pause)) {
          await withAbort(gate.wait(signal), signal);
          const status = await fetch(url, { headers, signal });
          if (status.status === 404) return;
          if (!status.ok) {
            throw await boatResponseError(status, config.apiKey, signal);
          }
          await abortableDelay(pause, signal);
        }
      } catch (error) {
        if (!signal.aborted || error !== signal.reason) throw error;
      }
      init?.signal?.throwIfAborted();
      throw new Error(`Boat ${sandboxId} was not deleted within 60 seconds`);
    },
  });
}

export function nextPoll(pause: number, max = BOAT_POLL_MAX_MS): number {
  return Math.min(pause * 2, max);
}

async function sandboxMissing(
  get: (request: { sandboxId: string }, init: RequestInit) => Promise<unknown>,
  sandboxId: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const timeout = AbortSignal.timeout(BOAT_GONE_CHECK_TIMEOUT_MS);
  try {
    await get({ sandboxId }, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    return false;
  } catch (error) {
    return error instanceof BoatApiError && error.response.status === 404;
  }
}
