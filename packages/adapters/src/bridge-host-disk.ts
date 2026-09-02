import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  ComputerFileEntry,
  HostDiskProvider,
  PortableFile,
} from "@rakazo/adapter-kit";
import { hostDiskAccessAllowed, loadHostDiskSettings } from "./host-disk-settings.js";
import { LocalHostDiskProvider } from "./local-host-disk.js";

export type HostDiskOperationKind = "list" | "read" | "write";

export type HostDiskOperation = {
  id: string;
  userId: string;
  kind: HostDiskOperationKind;
  path: string;
  /** Base64 payload for write requests and read results. */
  contentBase64?: string;
  maxBytes?: number;
  status: "pending" | "claimed" | "done" | "error";
  entries?: ComputerFileEntry[];
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type BridgingHostDiskOptions = {
  dataDir: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Extra wait after timeout for an in-flight completer to publish .done/.error. */
  completionGraceMs?: number;
  /**
   * Max wait after timeout while an exclusive `.claimed.json` or `.completing.json`
   * owner is still in flight. Fixed grace alone can expire before a slow host op
   * publishes (and must not steal a live claim).
   */
  completingHoldMs?: number;
  /** Absolute bound while `.claimed.json` / `.completing.json` is held (crash ceiling). */
  completingMaxMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_POLL_MS = 200;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_COMPLETION_GRACE_MS = 2_000;
/** Bound for waiting on exclusive `.completing.json` after the main timeout. */
const DEFAULT_COMPLETING_HOLD_MS = 30_000;
/** Crash ceiling while `.completing.json` remains held (10 minutes). */
const DEFAULT_COMPLETING_MAX_MS = 600_000;

/**
 * Queues host-disk work for a connected Mac/phone client. The API exposes claim
 * and complete RPCs; the desktop/mobile app performs FS I/O inside granted roots.
 */
export class BridgingHostDiskProvider implements HostDiskProvider {
  constructor(private readonly options: BridgingHostDiskOptions) {}

  describe() {
    return {
      id: "bridging-host-disk",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { list: true, read: true, write: true },
    };
  }

  async isAvailable(userId: string): Promise<boolean> {
    const settings = await loadHostDiskSettings(this.options.dataDir, userId);
    return hostDiskAccessAllowed(settings, this.options.now?.() ?? Date.now());
  }

  async listFiles(
    userId: string,
    requestPath: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const result = await this.runOperation(userId, { kind: "list", path: requestPath }, context);
    return result.entries ?? [];
  }

  async readFile(
    userId: string,
    requestPath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const result = await this.runOperation(
      userId,
      { kind: "read", path: requestPath, maxBytes: options?.maxBytes },
      context,
    );
    if (!result.contentBase64) throw new Error(result.error ?? "Host read returned no content");
    return Uint8Array.from(Buffer.from(result.contentBase64, "base64"));
  }

  async writeFile(userId: string, file: PortableFile, context: AdapterContext): Promise<void> {
    const result = await this.runOperation(
      userId,
      {
        kind: "write",
        path: file.path,
        contentBase64: Buffer.from(file.content).toString("base64"),
      },
      context,
    );
    if (result.status === "error") throw new Error(result.error ?? "Host write failed");
  }

  async claimNext(userId: string): Promise<HostDiskOperation | null> {
    return claimHostDiskOperation(this.options.dataDir, userId, this.options.now);
  }

  async complete(
    userId: string,
    input: {
      id: string;
      status: "done" | "error";
      entries?: ComputerFileEntry[];
      contentBase64?: string;
      error?: string;
    },
  ): Promise<HostDiskOperation> {
    return completeHostDiskOperation(this.options.dataDir, userId, input, this.options.now);
  }

  private async runOperation(
    userId: string,
    request: {
      kind: HostDiskOperationKind;
      path: string;
      contentBase64?: string;
      maxBytes?: number;
    },
    context: AdapterContext,
  ): Promise<HostDiskOperation> {
    if (!(await this.isAvailable(userId))) {
      throw new Error(
        "Host disk access is off. Opt in from the Mac or phone app and grant a folder.",
      );
    }
    const id = randomUUID();
    const now = new Date(this.options.now?.() ?? Date.now()).toISOString();
    const operation: HostDiskOperation = {
      id,
      userId,
      kind: request.kind,
      path: request.path,
      contentBase64: request.contentBase64,
      maxBytes: request.maxBytes,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const file = operationPath(this.options.dataDir, userId, id);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(operation, null, 2)}\n`, "utf8");

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    const sleep =
      this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const started = this.options.now?.() ?? Date.now();

    while ((this.options.now?.() ?? Date.now()) - started < timeoutMs) {
      if (context.signal.aborted) throw new Error("Host disk operation aborted");
      const current = await readOperationById(this.options.dataDir, userId, id);
      // Only immutable *.done.json / *.error.json are terminal. .completing.json
      // may briefly hold status done|error before rename; deleting it would race
      // the owner's terminal publish (ENOENT) while the caller already saw success.
      if (
        current &&
        isTerminalOperationFile(current.file) &&
        (current.operation.status === "done" || current.operation.status === "error")
      ) {
        if (current.operation.status === "error") {
          throw new Error(current.operation.error ?? "Host disk operation failed");
        }
        void unlink(current.file).catch(() => undefined);
        return current.operation;
      }
      await sleep(pollMs);
    }
    // Do not timeout-complete yet: that would steal a live `.claimed.json` while
    // the client is still doing host FS work. Soft-slide while claimed or
    // completing is held (crash ceiling), then record timeout only after.
    const graceMs = this.options.completionGraceMs ?? DEFAULT_COMPLETION_GRACE_MS;
    const completingHoldMs = this.options.completingHoldMs ?? DEFAULT_COMPLETING_HOLD_MS;
    const completingMaxMs = this.options.completingMaxMs ?? DEFAULT_COMPLETING_MAX_MS;
    const graceStarted = this.options.now?.() ?? Date.now();
    const graceDeadline = graceStarted + graceMs;
    // Crash ceiling for a held `.claimed.json` / `.completing.json`. Soft sliding
    // uses completingHoldMs per poll so a live exclusive owner is not cut off by
    // a short fixed deadline; completingMaxMs bounds a crashed holder.
    const liveOwnerCrashCeiling = graceStarted + completingMaxMs;
    let sawLiveOwner = false;
    let postLiveOwnerGraceDeadline: number | null = null;
    for (;;) {
      const final = await readOperationById(this.options.dataDir, userId, id);
      if (final && isTerminalOperationFile(final.file) && final.operation.status === "done") {
        void unlink(final.file).catch(() => undefined);
        return final.operation;
      }
      if (final && isTerminalOperationFile(final.file) && final.operation.status === "error") {
        throw new Error(final.operation.error ?? "Host disk operation failed");
      }
      const now = this.options.now?.() ?? Date.now();
      const claimedInFlight = final?.file.endsWith(".claimed.json") === true;
      const completingInFlight = final?.file.endsWith(".completing.json") === true;
      const liveOwnerInFlight = claimedInFlight || completingInFlight;
      if (liveOwnerInFlight) {
        sawLiveOwner = true;
        postLiveOwnerGraceDeadline = null;
      } else if (sawLiveOwner && postLiveOwnerGraceDeadline === null) {
        // Live owner gone — brief window for claimed/completing → terminal rename.
        postLiveOwnerGraceDeadline = now + graceMs;
      }
      const deadline = liveOwnerInFlight
        ? // Slide while exclusive owner holds claimed/completing; only the long
          // crash ceiling can stop a live holder (not the short soft-hold window).
          Math.min(liveOwnerCrashCeiling, now + completingHoldMs)
        : sawLiveOwner
          ? Math.min(liveOwnerCrashCeiling, postLiveOwnerGraceDeadline ?? liveOwnerCrashCeiling)
          : graceDeadline;
      if (now >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(0, deadline - now)));
    }
    await this.complete(userId, {
      id,
      status: "error",
      error: "Timed out waiting for the Mac or phone app to handle host disk access",
    }).catch(() => undefined);
    const raced = await readOperationById(this.options.dataDir, userId, id);
    if (raced && isTerminalOperationFile(raced.file) && raced.operation.status === "done") {
      void unlink(raced.file).catch(() => undefined);
      return raced.operation;
    }
    if (raced && isTerminalOperationFile(raced.file) && raced.operation.status === "error") {
      throw new Error(raced.operation.error ?? "Host disk operation failed");
    }
    throw new Error("Timed out waiting for the Mac or phone app to handle host disk access");
  }
}

function operationsDir(dataDir: string, userId: string) {
  return path.join(dataDir, "host-disk", "operations", userId);
}

function operationPath(dataDir: string, userId: string, id: string) {
  return path.join(operationsDir(dataDir, userId), `${id}.json`);
}

function claimedOperationPath(dataDir: string, userId: string, id: string) {
  return path.join(operationsDir(dataDir, userId), `${id}.claimed.json`);
}

function completingOperationPath(dataDir: string, userId: string, id: string) {
  return path.join(operationsDir(dataDir, userId), `${id}.completing.json`);
}

function isTerminalOperationFile(file: string) {
  return file.endsWith(".done.json") || file.endsWith(".error.json");
}

function terminalOperationPath(
  dataDir: string,
  userId: string,
  id: string,
  status: "done" | "error",
) {
  return path.join(operationsDir(dataDir, userId), `${id}.${status}.json`);
}

async function readOperationById(
  dataDir: string,
  userId: string,
  id: string,
): Promise<{ operation: HostDiskOperation; file: string } | null> {
  // Prefer immutable terminal files so a late completer cannot revive claimed.
  for (const status of ["done", "error"] as const) {
    const terminalPath = terminalOperationPath(dataDir, userId, id, status);
    const terminal = await readOperationFile(terminalPath);
    if (terminal) return { operation: terminal, file: terminalPath };
  }
  // In-flight exclusive take: visible so waiters do not treat the op as vanished.
  const completingPath = completingOperationPath(dataDir, userId, id);
  const completing = await readOperationFile(completingPath);
  if (completing) return { operation: completing, file: completingPath };
  const claimedPath = claimedOperationPath(dataDir, userId, id);
  const pendingPath = operationPath(dataDir, userId, id);
  const claimed = await readOperationFile(claimedPath);
  if (claimed) return { operation: claimed, file: claimedPath };
  const pending = await readOperationFile(pendingPath);
  if (pending) return { operation: pending, file: pendingPath };
  return null;
}

async function readOperationFile(file: string): Promise<HostDiskOperation | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as HostDiskOperation;
  } catch {
    return null;
  }
}

export async function claimHostDiskOperation(
  dataDir: string,
  userId: string,
  now: () => number = Date.now,
): Promise<HostDiskOperation | null> {
  const dir = operationsDir(dataDir, userId);
  await mkdir(dir, { recursive: true });
  const names = (await readdir(dir))
    .filter(
      (name) =>
        name.endsWith(".json") &&
        !name.endsWith(".claimed.json") &&
        !name.endsWith(".completing.json") &&
        !name.endsWith(".done.json") &&
        !name.endsWith(".error.json"),
    )
    .sort();
  for (const name of names) {
    const pendingPath = path.join(dir, name);
    const claimedPath = path.join(dir, `${name.slice(0, -".json".length)}.claimed.json`);
    try {
      // Atomic take: only one client can rename the pending file.
      await rename(pendingPath, claimedPath);
    } catch {
      continue;
    }
    const operation = await readOperationFile(claimedPath);
    if (!operation || operation.userId !== userId) {
      void unlink(claimedPath).catch(() => undefined);
      continue;
    }
    const claimed: HostDiskOperation = {
      ...operation,
      status: "claimed",
      updatedAt: new Date(now()).toISOString(),
    };
    await writeFile(claimedPath, `${JSON.stringify(claimed, null, 2)}\n`, "utf8");
    return claimed;
  }
  return null;
}

export async function completeHostDiskOperation(
  dataDir: string,
  userId: string,
  input: {
    id: string;
    status: "done" | "error";
    entries?: ComputerFileEntry[];
    contentBase64?: string;
    error?: string;
  },
  now: () => number = Date.now,
): Promise<HostDiskOperation> {
  const pendingPath = operationPath(dataDir, userId, input.id);
  const claimedPath = claimedOperationPath(dataDir, userId, input.id);
  const completingPath = completingOperationPath(dataDir, userId, input.id);
  const terminalPath = terminalOperationPath(dataDir, userId, input.id, input.status);

  // Already terminal? Reject without touching live files.
  for (const status of ["done", "error"] as const) {
    const existingTerminal = await readOperationFile(
      terminalOperationPath(dataDir, userId, input.id, status),
    );
    if (existingTerminal) {
      throw new Error("Host disk operation already completed");
    }
  }

  // Exclusive take of the live op (claimed preferred, then pending).
  let takenFrom: string | null = null;
  for (const candidate of [claimedPath, pendingPath]) {
    try {
      await rename(candidate, completingPath);
      takenFrom = candidate;
      break;
    } catch {
      // Lost the race or file missing; try the other candidate.
    }
  }

  if (!takenFrom) {
    // Another completer may have just published a terminal file.
    for (const status of ["done", "error"] as const) {
      const existingTerminal = await readOperationFile(
        terminalOperationPath(dataDir, userId, input.id, status),
      );
      if (existingTerminal) {
        throw new Error("Host disk operation already completed");
      }
    }
    throw new Error("Host disk operation not found");
  }

  try {
    const existing = await readOperationFile(completingPath);
    if (!existing || existing.userId !== userId) {
      throw new Error("Host disk operation not found");
    }
    if (existing.status === "done" || existing.status === "error") {
      throw new Error("Host disk operation already completed");
    }
    const updated: HostDiskOperation = {
      ...existing,
      status: input.status,
      entries: input.entries,
      contentBase64: input.contentBase64 ?? existing.contentBase64,
      error: input.error,
      updatedAt: new Date(now()).toISOString(),
    };
    await writeFile(completingPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    // Publish an immutable terminal name (done|error). A late completer cannot
    // rename claimed again because claimed is gone and terminal rename is exclusive.
    await rename(completingPath, terminalPath);
    return updated;
  } catch (error) {
    // If we fail after taking the file, try to put it back so a retry can finish.
    try {
      await rename(completingPath, takenFrom);
    } catch {
      // Best-effort restore.
    }
    throw error;
  }
}

/** Production default is the client bridge; set RAKAZO_HOST_DISK_MODE=local for same-host FS. */
export function createHostDiskProvider(dataDir: string): HostDiskProvider {
  if (process.env.RAKAZO_HOST_DISK_MODE === "local") {
    return new LocalHostDiskProvider({ dataDir, ignoreClientHeartbeat: true });
  }
  return new BridgingHostDiskProvider({ dataDir });
}
