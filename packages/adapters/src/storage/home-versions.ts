import { COMPUTER_RUNNING_ERROR } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

/** The newest saves are kept whatever their day, so a bad last save can be undone at once. */
const RECENT_HOME_VERSIONS = 2;
/**
 * The first save of each of this many UTC days is kept too: a computer that saves every few
 * minutes would otherwise push every good copy out within hours of being damaged, and a day's
 * first save is from before anything that went wrong later that day.
 */
const HOME_VERSION_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;
/** Only a computer that is not running can have its home replaced. */
const IDLE_STATES = ["stopped", "suspended", "error"];

export interface HomeVersion {
  revision: string;
  savedAt: Date;
}

/** The stored home's current revision and its kept revisions, current included. */
export interface HomeVersions {
  storageId: string;
  current: string | null;
  versions: HomeVersion[];
}

export class HomeVersionNotFoundError extends ClientError {
  constructor() {
    super("NOT_FOUND", "That version is no longer kept");
    this.name = "HomeVersionNotFoundError";
  }
}

export class HomeRestoreRunningError extends ClientError {
  constructor() {
    super(
      "CONFLICT",
      "Stop the computer before restoring an earlier version",
      COMPUTER_RUNNING_ERROR,
    );
    this.name = "HomeRestoreRunningError";
  }
}

export class HomeRestoreChangedError extends ClientError {
  constructor() {
    super("CONFLICT", "The computer's files changed meanwhile. Try again.");
    this.name = "HomeRestoreChangedError";
  }
}

/** Thrown inside a prune's transaction to roll it back when it would drop the current revision. */
class PruneRaceError extends Error {}

/**
 * The revisions a save keeps: the current one, the newest few, and the first save of each recent
 * day. Saves spread across days survive a burst of saves of a damaged home.
 */
export function keptHomeRevisions(
  versions: readonly HomeVersion[],
  current: string | null,
  now: Date,
): Set<string> {
  const kept = new Set<string>(current ? [current] : []);
  const newest = [...versions].sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
  for (const version of newest.slice(0, RECENT_HOME_VERSIONS)) kept.add(version.revision);
  const firstDay = Math.floor(now.getTime() / DAY_MS) - (HOME_VERSION_DAYS - 1);
  const firstOfDay = new Map<number, HomeVersion>();
  // Newest first, so the last one seen for a day is its first save.
  for (const version of newest) {
    const day = Math.floor(version.savedAt.getTime() / DAY_MS);
    if (day >= firstDay) firstOfDay.set(day, version);
  }
  for (const version of firstOfDay.values()) kept.add(version.revision);
  return kept;
}

type VersionsDb = Pick<PrismaClient, "computer" | "computerHomeVersion" | "$transaction">;

export function loadHomeVersions(
  prisma: VersionsDb,
  homeKey: string,
): Promise<HomeVersions | undefined> {
  return runAsSystem("list an agent home's kept versions", async () => {
    const computer = await prisma.computer.findUnique({
      where: { homeKey },
      select: { id: true, homeStorageId: true, homeStorageRevision: true },
    });
    if (!computer?.homeStorageId) return undefined;
    const versions = await prisma.computerHomeVersion.findMany({
      where: { computerId: computer.id, storageId: computer.homeStorageId },
      select: { revision: true, savedAt: true },
      orderBy: { savedAt: "desc" },
    });
    return {
      storageId: computer.homeStorageId,
      current: computer.homeStorageRevision,
      versions,
    };
  });
}

/**
 * Records `to` as a kept version saved now. A home saved before versions were recorded has no
 * row for its previous revision yet; it is recorded with the time that save finished.
 */
export async function recordHomeVersion(
  prisma: Pick<PrismaClient, "computerHomeVersion">,
  computer: { id: string; homeRevisionAt: Date | null; updatedAt: Date },
  storageId: string,
  from: string | null,
  to: string,
): Promise<void> {
  await prisma.computerHomeVersion.createMany({
    data: [
      ...(from
        ? [
            {
              computerId: computer.id,
              storageId,
              revision: from,
              savedAt: computer.homeRevisionAt ?? computer.updatedAt,
            },
          ]
        : []),
      { computerId: computer.id, storageId, revision: to, savedAt: new Date() },
    ],
    skipDuplicates: true,
  });
}

/**
 * Forgets the versions the policy no longer keeps and returns their revisions, whose objects the
 * caller then deletes. Never returns the current revision, even when a restore makes one of them
 * current meanwhile: a restore locks the version's row first, so this either deletes it before
 * the restore looks or sees it current afterwards and gives up.
 */
export function pruneHomeVersions(
  prisma: VersionsDb,
  homeKey: string,
  storageId: string,
  now: Date,
): Promise<string[]> {
  return runAsSystem("prune an agent home's kept versions", async () => {
    try {
      return await prisma.$transaction(async (tx) => {
        const computer = await tx.computer.findUnique({
          where: { homeKey },
          select: { id: true, homeStorageId: true, homeStorageRevision: true },
        });
        if (computer?.homeStorageId !== storageId) return [];
        const versions = await tx.computerHomeVersion.findMany({
          where: { computerId: computer.id, storageId },
          select: { id: true, revision: true, savedAt: true },
        });
        const kept = keptHomeRevisions(versions, computer.homeStorageRevision, now);
        const dropped = versions.filter((version) => !kept.has(version.revision));
        if (!dropped.length) return [];
        await tx.computerHomeVersion.deleteMany({
          where: { id: { in: dropped.map((version) => version.id) } },
        });
        const after = await tx.computer.findUnique({
          where: { id: computer.id },
          select: { homeStorageRevision: true },
        });
        if (dropped.some((version) => version.revision === after?.homeStorageRevision))
          throw new PruneRaceError();
        return dropped.map((version) => version.revision);
      });
    } catch (error) {
      if (error instanceof PruneRaceError) return [];
      throw error;
    }
  });
}

/**
 * Makes a kept revision the current one, keeping the revision it replaces restorable. Only a
 * computer that is not running qualifies; its next start puts the restored files on it.
 */
export function restoreHomeVersion(
  prisma: VersionsDb,
  homeKey: string,
  storageId: string,
  revision: string,
): Promise<void> {
  return runAsSystem("restore an earlier version of an agent home", () =>
    prisma.$transaction(async (tx) => {
      const computer = await tx.computer.findUnique({
        where: { homeKey },
        select: {
          id: true,
          state: true,
          maintenanceId: true,
          providerRef: true,
          restorePending: true,
          homeStorageId: true,
          homeStorageRevision: true,
          homeRevisionAt: true,
          updatedAt: true,
        },
      });
      if (computer?.homeStorageId !== storageId) throw new HomeVersionNotFoundError();
      if (!IDLE_STATES.includes(computer.state) || computer.maintenanceId)
        throw new HomeRestoreRunningError();
      const current = computer.homeStorageRevision;
      if (current === revision) return;
      // Writing the row locks it, so a prune deleting it meanwhile commits first or gives up.
      const locked = await tx.computerHomeVersion.updateMany({
        where: { computerId: computer.id, storageId, revision },
        data: { storageId },
      });
      if (locked.count !== 1) throw new HomeVersionNotFoundError();
      if (current)
        await tx.computerHomeVersion.createMany({
          data: {
            computerId: computer.id,
            storageId,
            revision: current,
            savedAt: computer.homeRevisionAt ?? computer.updatedAt,
          },
          skipDuplicates: true,
        });
      const moved = await tx.computer.updateMany({
        where: {
          id: computer.id,
          state: computer.state,
          maintenanceId: null,
          homeStorageId: storageId,
          homeStorageRevision: current,
        },
        data: {
          homeStorageRevision: revision,
          homeRevision: revision,
          // A machine that kept its disk gets the restored files on its next start.
          restorePending: computer.restorePending || computer.providerRef !== null,
        },
      });
      if (moved.count === 1) return;
      // Another transaction changed the computer meanwhile: say what it was.
      const now = await tx.computer.findUnique({
        where: { id: computer.id },
        select: { state: true, maintenanceId: true, homeStorageId: true },
      });
      if (now?.homeStorageId !== storageId) throw new HomeVersionNotFoundError();
      if (!IDLE_STATES.includes(now.state) || now.maintenanceId)
        throw new HomeRestoreRunningError();
      throw new HomeRestoreChangedError();
    }),
  );
}
