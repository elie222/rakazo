import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { LeaseHeldError, parseComputerMode, withLease } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { RECEIVED_FILE_MAX_AGE_MS } from "./received-path.js";
import { homeHoldsReceivedFiles } from "./save-received-file.js";

/** How often received copies are looked at for pruning. */
const PRUNE_INTERVAL_MS = 60 * 60_000;
/** How long a prune holds a computer's received folder before another process may take it. */
const PRUNE_LEASE_MS = 60_000;
const COMPUTER_PAGE_SIZE = 100;

/** `YYYY-MM-DD_HHMM_` at the start of a received file's name; the date is the time it arrived. */
const RECEIVED_NAME = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})_/;

function arrivedAt(fileName: string): number | undefined {
  const match = RECEIVED_NAME.exec(fileName);
  if (!match) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const at = Date.UTC(year, month - 1, day, hour, minute);
  // The name's own time zone is not known here, which a day's slack in a month's limit absorbs.
  return Number.isNaN(at) ? undefined : at;
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
        const at = arrivedAt(baseName(file.path));
        if (file.kind === "file" && at !== undefined && at < cutoff) expired.push(file.path);
      }
    }
  }
  return expired;
}

/** Emptied month and year folders under `root` go with the files; `root` itself stays. */
async function pruneComputer(
  home: AgentHomeStore,
  computer: { homeKey: string; scope: string },
  cutoff: number,
  context: AdapterContext,
): Promise<number> {
  const root = parseComputerMode(computer.scope) === "team" ? "shared/received" : "received";
  const list = (directory: string) =>
    home.list(computer.homeKey, directory, context) as Promise<Listing>;
  const files = await expiredFiles(list, root, cutoff);
  if (!files.length) return 0;
  await home.removeFiles(computer.homeKey, files, context, { emptyFoldersBelow: root });
  return files.length;
}

/**
 * The worker's hourly pass that deletes received chat-app files a month after they arrived
 * (by the date in their name, never the file's own time), then the month and year folders that
 * leaves empty. Only homes the server holds are pruned: a computer running on a provider's
 * own disk is left alone. Anything not named like a received file stays. Off unless the
 * setting is on.
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
        where: after ? { id: { gt: after } } : undefined,
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
          (await bestEffort(
            `prune received files of computer ${computer.id}`,
            // A save holds the same lease, so a prune never runs beside one; the next pass retries.
            withLease(
              deps.prisma,
              `received-files:${computer.id}`,
              { ttlMs: PRUNE_LEASE_MS, signal: context.signal },
              () => pruneComputer(deps.home, computer, cutoff, context),
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
