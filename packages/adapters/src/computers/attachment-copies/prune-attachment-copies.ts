import path from "node:path";
import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { LeaseHeldError, parseComputerMode, withLease } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { ATTACHMENT_NAME_PATTERN } from "../../storage/attachment-path.js";
import { bestEffortWithoutPaths, homeHoldsAttachmentCopies } from "./copy-attachment.js";
import type { FilesCleanupSettings } from "./files-cleanup-settings.js";

/** How long a prune holds a computer's attachment copies before another process may take them. */
const PRUNE_LEASE_MS = 60_000;
const COMPUTER_PAGE_SIZE = 100;

/** The shape of a Rakazo row id, which names a copy that keeps no readable name. */
const ARTIFACT_ID = /^c[0-9a-z]{24}$/;

/**
 * When an attachment arrived, from `YYYY-MM-DD_HHMM_` in its name, or undefined when the name
 * is not one or its date is not real. With `folders`, they must name the same year and month.
 * The name is written in the user's time zone and read here as UTC; the difference is hours,
 * well within the slack of a day over a retention of weeks.
 */
function arrivedAt(
  fileName: string,
  folders?: { year: string; month: string },
): number | undefined {
  if (!ATTACHMENT_NAME_PATTERN.test(fileName)) return undefined;
  // The folders name the same year and month, or the file is not one of ours.
  if (
    folders &&
    (fileName.slice(0, 4) !== folders.year || fileName.slice(5, 7) !== folders.month)
  ) {
    return undefined;
  }
  const y = Number(fileName.slice(0, 4));
  const m = Number(fileName.slice(5, 7));
  const d = Number(fileName.slice(8, 10));
  const hour = Number(fileName.slice(11, 13));
  const minute = Number(fileName.slice(13, 15));
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

/** A file in an attachments folder: when it arrived, or the artifact whose age says so. */
type Candidate =
  | { root: string; path: string; at: number }
  | { root: string; path: string; artifactId: string };

/**
 * The files of `root` that may be old: `YYYY/MM/<name>` and `<name>` dated by their names, and
 * `<id><ext>` named by an artifact's id. Anything else is not ours and is left out.
 */
async function candidates(
  list: (directory: string) => Promise<Listing>,
  root: string,
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const entry of await listExisting(list, root)) {
    if (entry.kind === "file") {
      const name = baseName(entry.path);
      const at = arrivedAt(name);
      const id = path.basename(name, path.extname(name));
      if (at !== undefined) found.push({ root, path: entry.path, at });
      else if (ARTIFACT_ID.test(id)) found.push({ root, path: entry.path, artifactId: id });
      continue;
    }
    const year = baseName(entry.path);
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of await list(entry.path)) {
      if (month.kind !== "dir" || !/^\d{2}$/.test(baseName(month.path))) continue;
      for (const file of await list(month.path)) {
        const at = arrivedAt(baseName(file.path), { year, month: baseName(month.path) });
        if (file.kind === "file" && at !== undefined) found.push({ root, path: file.path, at });
      }
    }
  }
  return found;
}

/** The attachments folders of a computer's home: one on a dedicated computer, one per bot on a team's. */
async function attachmentRoots(
  list: (directory: string) => Promise<Listing>,
  scope: string,
): Promise<string[]> {
  if (parseComputerMode(scope) !== "team") return ["attachments"];
  const bots = await listExisting(list, "bots");
  return bots.filter((entry) => entry.kind === "dir").map((entry) => `${entry.path}/attachments`);
}

/** Files a prune deletes between two looks at the computer's state. */
const PRUNE_BATCH_FILES = 25;
/** Files a prune deletes in one home per pass; the rest wait for the next pass. */
const PRUNE_MAX_FILES = 500;

/**
 * Deletes the expired files under each of the home's attachments folders and the month and year
 * folders that empties, while the computer stays as it was first read. A start does not take
 * this lease, so before each batch the computer is read again, and any change in its state stops
 * the deletion: a computer that wakes runs a bot that could swap a folder for a link. The cap
 * keeps a home full of planted names from holding the loop open.
 */
async function pruneComputer(
  deps: { prisma: PrismaClient; home: AgentHomeStore; sandbox: SandboxProvider },
  computer: { id: string; spaceId: string; homeKey: string; scope: string },
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
  if (!first || !homeHoldsAttachmentCopies(deps.sandbox, first)) return 0;
  const unchanged = async () => {
    const current = await read();
    return (
      current !== null &&
      current.state === first.state &&
      current.providerRef === first.providerRef &&
      current.updatedAt.getTime() === first.updatedAt.getTime() &&
      homeHoldsAttachmentCopies(deps.sandbox, current)
    );
  };
  const list = (directory: string) =>
    deps.home.list(computer.homeKey, directory, context) as Promise<Listing>;
  const found: Candidate[] = [];
  for (const root of await attachmentRoots(list, computer.scope)) {
    found.push(...(await candidates(list, root)));
  }
  // One lookup for the home, in the computer's Space: another Space's artifact is not ours.
  const ids = found.flatMap((file) => ("artifactId" in file ? [file.artifactId] : []));
  const created = new Map<string, number>();
  if (ids.length) {
    const rows = await deps.prisma.artifact.findMany({
      where: { id: { in: ids }, spaceId: computer.spaceId },
      select: { id: true, createdAt: true },
    });
    for (const row of rows) created.set(row.id, row.createdAt.getTime());
  }
  const expired = found
    .filter((file) => {
      const at = "at" in file ? file.at : created.get(file.artifactId);
      return at !== undefined && at < cutoff;
    })
    .slice(0, PRUNE_MAX_FILES);
  let removed = 0;
  for (const root of new Set(expired.map((file) => file.root))) {
    const files = expired.filter((file) => file.root === root).map((file) => file.path);
    for (let at = 0; at < files.length; at += PRUNE_BATCH_FILES) {
      if (signal.aborted || !(await unchanged())) return removed;
      const batch = files.slice(at, at + PRUNE_BATCH_FILES);
      removed += await deps.home.removeFiles(computer.homeKey, batch, root, context, { signal });
    }
  }
  return removed;
}

/**
 * The worker's pass that deletes the copies of attachments in computers once they are older
 * than the settings say, then the month and year folders that leaves empty. A copy's age is the
 * date in its name, or, when it is named by its artifact's id, the artifact's creation time (never
 * the file's own time). Only homes the server holds while nothing runs in them are cleaned
 * (see `homeHoldsAttachmentCopies`): a running computer, Docker included, and one on a
 * provider's own disk are left alone. Anything else in the folder stays. It looks at most once
 * per interval in this process, and is off unless the settings turn it on.
 */
export function createAttachmentCopiesPruner(deps: {
  prisma: PrismaClient;
  home: AgentHomeStore;
  sandbox: SandboxProvider;
  settings: FilesCleanupSettings;
  now?: () => Date;
}): (() => Promise<void>) | undefined {
  if (!deps.settings.attachments) return undefined;
  const now = deps.now ?? (() => new Date());
  let lastRun: number | undefined;
  return async () => {
    const started = now().getTime();
    if (lastRun !== undefined && started - lastRun < deps.settings.intervalMs) return;
    lastRun = started;
    const cutoff = started - deps.settings.maxAgeMs;
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
        if (!homeHoldsAttachmentCopies(deps.sandbox, computer)) continue;
        const context: AdapterContext = {
          operationId: `attachment-copies-prune:${computer.id}`,
          traceId: `attachment-copies-prune:${computer.id}`,
          spaceId: computer.spaceId,
          userId: computer.userId,
          signal: new AbortController().signal,
        };
        removed +=
          (await bestEffortWithoutPaths(
            `prune attachment copies of computer ${computer.id}`,
            // A copy holds the same lease, so a prune never runs beside one; the next pass retries.
            withLease(
              deps.prisma,
              `attachment-copies:${computer.id}`,
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
    if (removed) {
      getLogger().info("attachment-copies.pruned", { "attachment.copies.removed": removed });
    }
  };
}
