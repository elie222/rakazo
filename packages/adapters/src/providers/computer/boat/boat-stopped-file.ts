import { SandboxFileTooLargeError } from "@rakazo/adapter-kit";
import {
  anySignal,
  cancelResponseBody,
  deadlineSignal,
  ResponseTooLargeError,
  readResponseWithin,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { BoatSandboxSdk } from "./boat-client.js";
import { BoatApiError } from "./boat-errors.js";

type SnapshotClient = Pick<
  BoatSandboxSdk,
  "get" | "getStop" | "getLatestSandboxSnapshot" | "getSnapshotFileRaw"
>;

/** A slow snapshot lookup should give way to the normal live read. */
const STOPPED_READ_TIMEOUT_MS = 30_000;

type Step = "get" | "latest" | "stop" | "file" | "read";

function fallBackToLiveRead(
  report: { reason?: string; status?: number },
  reason: string,
  status?: number,
) {
  report.reason = reason;
  report.status = status;
  getLogger().info("computer.stopped_file_fallback", { provider: "boat", reason, status });
  return undefined;
}

export async function readBoatStoppedFile(
  client: SnapshotClient,
  sandboxId: string,
  path: string,
  callerSignal: AbortSignal,
  { maxBytes, savedAt }: { maxBytes: number; savedAt?: Date },
): Promise<Uint8Array | undefined> {
  const signal = deadlineSignal(STOPPED_READ_TIMEOUT_MS, callerSignal);
  const startedAt = Date.now();
  const stepMs: Partial<Record<Step, number>> = {};
  const unfinished = new Map<Step, number>();
  const cutOff = new Set<Step>();
  const report: { reason?: string; status?: number; bytes?: number } = {};

  const timed = <T>(step: Step, call: Promise<T>): Promise<T> => {
    unfinished.set(step, Date.now());
    const finish = () => {
      stepMs[step] = Date.now() - (unfinished.get(step) ?? startedAt);
      unfinished.delete(step);
    };
    return call.then(
      (value) => {
        finish();
        return value;
      },
      (error: unknown) => {
        finish();
        if (signal.aborted && !callerSignal.aborted) cutOff.add(step);
        throw error;
      },
    );
  };

  /**
   * A request started before the check that decides whether it is needed. Its failure surfaces
   * only where `result` is awaited, and `drop` cancels it without delaying the fallback.
   */
  const startAside = <T>(step: Step, call: (signal: AbortSignal) => Promise<T>) => {
    const controller = new AbortController();
    const settled = timed(step, call(anySignal([signal, controller.signal]))).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    return {
      result: async (): Promise<T> => {
        const outcome = await settled;
        if ("error" in outcome) throw outcome.error;
        return outcome.value;
      },
      drop: (release?: (value: T) => void) => {
        controller.abort();
        void settled.then((outcome) => {
          if ("value" in outcome) release?.(outcome.value);
        });
      },
    };
  };

  let outcome: "read" | "fallback" | "too_large" | "aborted" | "error" = "error";
  try {
    // Boat serves the latest snapshot by sandbox id, so it is asked for alongside the sandbox.
    const latest = startAside("latest", (aside) =>
      client.getLatestSandboxSnapshot({ sandboxId }, { signal: aside }),
    );
    let sandbox: Awaited<ReturnType<SnapshotClient["get"]>>["sandbox"];
    try {
      ({ sandbox } = await timed("get", client.get({ sandboxId }, { signal })));
    } catch (error) {
      latest.drop();
      throw error;
    }
    const { stoppedAt, snapshotCompletedAt, snapshotVerifiedAt, stop } = sandbox;
    if (
      sandbox.state !== "archived" ||
      sandbox.dataExpiredAt ||
      sandbox.wipePendingUntilRestart ||
      !sandbox.snapshotAvailable ||
      !stoppedAt ||
      !snapshotCompletedAt ||
      stop?.status !== "completed" ||
      !stop.endedAt ||
      stop.endedAt < stoppedAt ||
      (savedAt && savedAt > snapshotCompletedAt)
    ) {
      latest.drop();
      outcome = "fallback";
      return fallBackToLiveRead(report, "unverified_stop");
    }
    const snapshot = (await latest.result()).snapshot;
    if (
      snapshot?.sandboxId !== sandboxId ||
      snapshot.status !== "completed" ||
      snapshot.origin !== "captured" ||
      snapshot.completedAt?.getTime() !== snapshotCompletedAt.getTime()
    ) {
      outcome = "fallback";
      return fallBackToLiveRead(report, "unverified_snapshot");
    }

    // A forced stop can retain an older snapshot. Verify the save was checked during this
    // stop, allowing Boat to reuse an unchanged snapshot when its disk check found no writes.
    // The file is requested alongside that check but only returned once the check passes.
    const file = startAside("file", (aside) =>
      client.getSnapshotFileRaw({ snapshotId: snapshot.id, path }, { signal: aside }),
    );
    let operation: Awaited<ReturnType<SnapshotClient["getStop"]>>["stop"];
    try {
      ({ stop: operation } = await timed(
        "stop",
        client.getStop({ sandboxId, stopId: stop.id }, { signal }),
      ));
    } catch (error) {
      file.drop(({ raw }) => cancelResponseBody(raw));
      throw error;
    }
    const verifiedAt = snapshotVerifiedAt ?? snapshotCompletedAt;
    if (
      operation.status !== "completed" ||
      operation.id !== stop.id ||
      !operation.requestedAt ||
      verifiedAt < operation.requestedAt
    ) {
      file.drop(({ raw }) => cancelResponseBody(raw));
      outcome = "fallback";
      return fallBackToLiveRead(report, "unverified_snapshot");
    }

    const { raw } = await file.result();
    if (raw.headers.get("x-snapshot-entry-kind") !== "file") {
      cancelResponseBody(raw);
      outcome = "fallback";
      return fallBackToLiveRead(report, "not_a_file");
    }
    const bytes = await timed(
      "read",
      readResponseWithin(raw, {
        maxBytes,
        signal,
        tooLargeMessage: "Saved file is too large",
      }),
    );
    outcome = "read";
    report.bytes = bytes.byteLength;
    return bytes;
  } catch (error) {
    if (callerSignal.aborted) outcome = "aborted";
    callerSignal.throwIfAborted();
    // The live path handles API refusals, including files or snapshots the index cannot serve.
    outcome = "fallback";
    if (signal.aborted) return fallBackToLiveRead(report, "deadline");
    if (error instanceof ResponseTooLargeError) {
      outcome = "too_large";
      throw new SandboxFileTooLargeError(maxBytes, { cause: error });
    }
    if (error instanceof BoatApiError)
      return fallBackToLiveRead(report, "snapshot_request_refused", error.response.status);
    outcome = "error";
    throw error;
  } finally {
    const now = Date.now();
    for (const [step, stepStartedAt] of unfinished) stepMs[step] = now - stepStartedAt;
    getLogger().info("computer.stopped_file_read", {
      provider: "boat",
      outcome,
      ...report,
      totalMs: now - startedAt,
      stepMs,
      unfinishedSteps:
        unfinished.size + cutOff.size ? [...cutOff, ...unfinished.keys()] : undefined,
    });
  }
}
