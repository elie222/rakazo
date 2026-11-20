import { SandboxFileTooLargeError } from "@rakazo/adapter-kit";
import {
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
const STOPPED_READ_TIMEOUT_MS = 15_000;

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
  const inFlightAtDeadline: Step[] = [];
  const report: { reason?: string; status?: number; bytes?: number } = {};

  const timed = <T>(step: Step, call: Promise<T>): Promise<T> => {
    const stepStartedAt = Date.now();
    const finish = () => {
      stepMs[step] = Date.now() - stepStartedAt;
    };
    return call.then(
      (value) => {
        finish();
        return value;
      },
      (error: unknown) => {
        finish();
        if (signal.aborted) inFlightAtDeadline.push(step);
        throw error;
      },
    );
  };

  let outcome: "read" | "fallback" | "too_large" | "aborted" | "error" = "error";
  try {
    // Boat serves the latest snapshot by sandbox id, so it is asked for alongside the sandbox.
    const [sandboxResult, latestResult] = await Promise.allSettled([
      timed("get", client.get({ sandboxId }, { signal })),
      timed("latest", client.getLatestSandboxSnapshot({ sandboxId }, { signal })),
    ]);
    if (sandboxResult.status === "rejected") throw sandboxResult.reason;
    const { sandbox } = sandboxResult.value;
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
      outcome = "fallback";
      return fallBackToLiveRead(report, "unverified_stop");
    }
    if (latestResult.status === "rejected") throw latestResult.reason;
    const snapshot = latestResult.value.snapshot;
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
    const [operationResult, fileResult] = await Promise.allSettled([
      timed("stop", client.getStop({ sandboxId, stopId: stop.id }, { signal })),
      timed("file", client.getSnapshotFileRaw({ snapshotId: snapshot.id, path }, { signal })),
    ]);
    if (operationResult.status === "rejected") {
      if (fileResult.status === "fulfilled") cancelResponseBody(fileResult.value.raw);
      throw operationResult.reason;
    }
    const { stop: operation } = operationResult.value;
    const verifiedAt = snapshotVerifiedAt ?? snapshotCompletedAt;
    if (
      operation.status !== "completed" ||
      operation.id !== stop.id ||
      !operation.requestedAt ||
      verifiedAt < operation.requestedAt
    ) {
      if (fileResult.status === "fulfilled") cancelResponseBody(fileResult.value.raw);
      outcome = "fallback";
      return fallBackToLiveRead(report, "unverified_snapshot");
    }

    if (fileResult.status === "rejected") throw fileResult.reason;
    const { raw } = fileResult.value;
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
    getLogger().info("computer.stopped_file_read", {
      provider: "boat",
      outcome,
      ...report,
      totalMs: Date.now() - startedAt,
      stepMs,
      inFlightAtDeadline: inFlightAtDeadline.length ? inFlightAtDeadline : undefined,
    });
  }
}
