import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { LeaseHeldError, parseComputerMode, withLease } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { RECEIVED_FILE_MAX_AGE_MS } from "./received-path.js";
import { bestEffortWithoutPaths, homeHoldsReceivedFiles } from "./save-received-file.js";

/**
 * How often received copies are looked at for pruning. Looking at a home loads it: a home kept
 * in object storage is downloaded whole to list one folder, and nothing stored tells without
 * that whether it has received files. A one-month retention does not need it more than daily.
 */
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
/** How long a prune holds a computer's received folder before another process may take it. */
const PRUNE_LEASE_MS = 60_000;
const COMPUTER_PAGE_SIZE = 100;

/** `YYYY-MM-DD_HHMM_` at the start of a received file's name; the date is the time it arrived. */
const RECEIVED_NAME = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})_/;

/**
 * When a received file arrived, from `YYYY-MM-DD_HHMM_` in its name, or undefined when the name
 * is not one or its date is not real. The name is written in the bot's time zone and read here
 * as UTC; the difference is hours, well within the retention's slack of a day over 30.
 */
function arrivedAt(fileName: string, year: string, month: string): number | undefined {
  const match = RECEIVED_NAME.exec(fileName);
  // The folders name the same year and month, or the file is not one of ours.
  if (!match || match[1] !== year || match[2] !== month) return undefined;
  const [y, m, d, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const at = new Date(Date.UTC(y, m - 1, d, hour, minute));
  const real =
    m >= 1 &&
    m <= 12 &&
    hour <= 23 &&
    minute <= 59 &&
    at.getUTCFullYear() === y &&
    at.getUTCMonth() === m - 1 &&
    at.getUTCDate() === d;
  return real ? at.getTime() : undefined;
}

type Listing = Array<{ path: string; kind: "file" | "dir" }>;

/** The entries of `directory` when it is there; listing never creates the folder. */
async function listExisting(
  list: (directory: string) => Promise<Listing>,
  directory: string,
): Promise<Listing> {
  let entries = await list("");
  let current = "";
  for (const segment of directory.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    const next = entries.find((entry) => entry.kind === "dir" && entry.path === current);
    if (!next) return [];
    entries = await list(current);
  }
  return entries;
}

const baseName = (entryPath: string) => entryPath.slice(entryPath.lastIndexOf("/") + 1);

/** Paths of received files in `root` (`YYYY/MM/<name>`) that arrived before `cutoff`. */
async function expiredFiles(
  list: (directory: string) => Promise<Listing>,
  root: string,
  cutoff: number,
): Promise<string[]> {
  const expired: string[] = [];
  for (const year of await listExisting(list, root)) {
    if (year.kind !== "dir" || !/^\d{4}$/.test(baseName(year.path))) continue;
    for (const month of await list(year.path)) {
      if (month.kind !== "dir" || !/^\d{2}$/.test(baseName(month.path))) continue;
      for (const file of await list(month.path)) {
        const at = arrivedAt(baseName(file.path), baseName(year.path), baseName(month.path));
        if (file.kind === "file" && at !== undefined && at < cutoff) expired.push(file.path);
      }
    }
  }
  return expired;
}

/** Files a prune deletes between two looks at the computer's state. */
const PRUNE_BATCH_FILES = 25;
/** Files a prune deletes in one home per pass; the rest wait for the next pass. */
const PRUNE_MAX_FILES = 500;

/**
 * Deletes the expired files under `root` and the month and year folders that empties, while the
 * computer stays as it was first read. A start does not take this lease, so before each batch
 * the computer is read again, and any change in its state stops the deletion: a computer that
 * wakes runs a bot that could swap a folder for a link. The cap keeps a home full of planted
 * names from holding the loop open.
 */
async function pruneComputer(
  deps: { prisma: PrismaClient; home: AgentHomeStore; sandbox: SandboxProvider },
  computer: { id: string; homeKey: string; scope: string },
  cutoff: number,
  context: AdapterContext,
  signal: AbortSignal,
): Promise<number> {
  const read = () =>
    deps.prisma.computer.findUnique({
      where: { id: computer.id },
      select: { kind: true, providerRef: true, state: true, updatedAt: true },
    });
  // Read again under the lease: the computer may have started since the page was read.
  const first = await read();
  if (!first || !homeHoldsReceivedFiles(deps.sandbox, first)) return 0;
  const unchanged = async () => {
    const current = await read();
    return (
      current !== null &&
      current.state === first.state &&
      current.providerRef === first.providerRef &&
      current.updatedAt.getTime() === first.updatedAt.getTime() &&
      homeHoldsReceivedFiles(deps.sandbox, current)
    );
  };
  const root = parseComputerMode(computer.scope) === "team" ? "shared/received" : "received";
  const list = (directory: string) =>
    deps.home.list(computer.homeKey, directory, context) as Promise<Listing>;
  const files = (await expiredFiles(list, root, cutoff)).slice(0, PRUNE_MAX_FILES);
  let removed = 0;
  for (let at = 0; at < files.length; at += PRUNE_BATCH_FILES) {
    if (signal.aborted || !(await unchanged())) break;
    const batch = files.slice(at, at + PRUNE_BATCH_FILES);
    removed += await deps.home.removeFiles(computer.homeKey, batch, root, context, { signal });
  }
  return removed;
}

/**
 * The worker's daily pass that deletes received chat-app files a month after they arrived
 * (by the date in their name, never the file's own time), then the month and year folders that
 * leaves empty. Only homes the server holds while nothing runs in them are pruned (see
 * `homeHoldsReceivedFiles`): a running computer, Docker included, and one on a provider's own
 * disk are left alone. Anything not named like a received file stays. Off unless the setting
 * is on.
 */
export function createReceivedFilesPruner(deps: {
  prisma: PrismaClient;
  home: AgentHomeStore;
  sandbox: SandboxProvider;
  enabled: boolean;
  now?: () => Date;
}): (() => Promise<void>) | undefined {
  if (!deps.enabled) return undefined;
  const now = deps.now ?? (() => new Date());
  let lastRun: number | undefined;
  return async () => {
    const started = now().getTime();
    if (lastRun !== undefined && started - lastRun < PRUNE_INTERVAL_MS) return;
    lastRun = started;
    const cutoff = started - RECEIVED_FILE_MAX_AGE_MS;
    let removed = 0;
    for (let after: string | undefined; ; ) {
      const computers = await deps.prisma.computer.findMany({
        where: {
          OR: [{ state: "stopped", providerRef: null }, { state: "suspended" }],
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: "asc" },
        take: COMPUTER_PAGE_SIZE,
        select: {
          id: true,
          spaceId: true,
          userId: true,
          scope: true,
          homeKey: true,
          kind: true,
          providerRef: true,
          state: true,
        },
      });
      for (const computer of computers) {
        if (!homeHoldsReceivedFiles(deps.sandbox, computer)) continue;
        const context: AdapterContext = {
          operationId: `received-files-prune:${computer.id}`,
          traceId: `received-files-prune:${computer.id}`,
          spaceId: computer.spaceId,
          userId: computer.userId,
          signal: new AbortController().signal,
        };
        removed +=
          (await bestEffortWithoutPaths(
            `prune received files of computer ${computer.id}`,
            // A save holds the same lease, so a prune never runs beside one; the next pass retries.
            withLease(
              deps.prisma,
              `received-files:${computer.id}`,
              { ttlMs: PRUNE_LEASE_MS, signal: context.signal },
              (lease) => pruneComputer(deps, computer, cutoff, context, lease.signal),
            ).catch((error: unknown) => {
              if (error instanceof LeaseHeldError) return 0;
              throw error;
            }),
          )) ?? 0;
      }
      if (computers.length < COMPUTER_PAGE_SIZE) break;
      after = computers.at(-1)?.id;
    }
    if (removed) getLogger().info("received-files.pruned", { "received.files.removed": removed });
  };
}
