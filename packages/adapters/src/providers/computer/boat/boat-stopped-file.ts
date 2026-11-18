import { SandboxUnresponsiveError } from "@rakazo/adapter-kit";
import {
  cancelResponseBody,
  deadlineSignal,
  ResponseTooLargeError,
  readResponseWithin,
} from "@rakazo/core";
import { BoatApiError } from "./boat-errors.js";
import type { BoatSandboxSdk } from "./boat-sandbox.js";

type SnapshotClient = Pick<
  BoatSandboxSdk,
  "get" | "getStop" | "getLatestSandboxSnapshot" | "getSnapshotFileRaw"
>;

/** A slow snapshot lookup should give way to the normal live read. */
const STOPPED_READ_TIMEOUT_MS = 5_000;

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
      return undefined;

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
      snapshot.origin !== "captured" ||
      snapshot.completedAt?.getTime() !== snapshotCompletedAt.getTime()
    )
      return undefined;

    const { raw } = await client.getSnapshotFileRaw({ snapshotId: snapshot.id, path }, { signal });
    if (raw.headers.get("x-snapshot-entry-kind") !== "file") {
      cancelResponseBody(raw);
      return undefined;
    }
    return await readResponseWithin(raw, {
      maxBytes,
      signal,
      tooLargeMessage: "Saved file is too large",
    });
  } catch (error) {
    callerSignal.throwIfAborted();
    // Missing paths, links and snapshots with no file index are handled by the live reader.
    if (
      signal.aborted ||
      error instanceof ResponseTooLargeError ||
      (error instanceof BoatApiError && [403, 404, 409].includes(error.response.status))
    )
      return undefined;
    if (error instanceof BoatApiError && error.response.status >= 500) {
      throw new SandboxUnresponsiveError("Boat snapshot read failed", { cause: error });
    }
    throw error;
  }
}
