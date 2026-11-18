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
const STOPPED_READ_TIMEOUT_MS = 5_000;

function fallBackToLiveRead(reason: string, status?: number) {
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
  try {
    const { sandbox } = await client.get({ sandboxId }, { signal });
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
    )
      return fallBackToLiveRead("unverified_stop");

    // A forced stop can retain an older snapshot. Verify the save was checked during this
    // stop, allowing Boat to reuse an unchanged snapshot when its disk check found no writes.
    const [operation, latest] = await Promise.all([
      client.getStop({ sandboxId, stopId: stop.id }, { signal }),
      client.getLatestSandboxSnapshot({ sandboxId }, { signal }),
    ]);
    const snapshot = latest.snapshot;
    const verifiedAt = snapshotVerifiedAt ?? snapshotCompletedAt;
    if (
      operation.stop.status !== "completed" ||
      operation.stop.id !== stop.id ||
      !operation.stop.requestedAt ||
      verifiedAt < operation.stop.requestedAt ||
      snapshot?.sandboxId !== sandboxId ||
      snapshot.status !== "completed" ||
      snapshot.origin !== "captured" ||
      snapshot.completedAt?.getTime() !== snapshotCompletedAt.getTime()
    )
      return fallBackToLiveRead("unverified_snapshot");

    const { raw } = await client.getSnapshotFileRaw({ snapshotId: snapshot.id, path }, { signal });
    if (raw.headers.get("x-snapshot-entry-kind") !== "file") {
      cancelResponseBody(raw);
      return fallBackToLiveRead("not_a_file");
    }
    return await readResponseWithin(raw, {
      maxBytes,
      signal,
      tooLargeMessage: "Saved file is too large",
    });
  } catch (error) {
    callerSignal.throwIfAborted();
    // The live path handles API refusals, including files or snapshots the index cannot serve.
    if (signal.aborted) return fallBackToLiveRead("deadline");
    if (error instanceof ResponseTooLargeError)
      throw new SandboxFileTooLargeError(maxBytes, { cause: error });
    if (error instanceof BoatApiError)
      return fallBackToLiveRead("snapshot_request_refused", error.response.status);
    throw error;
  }
}
