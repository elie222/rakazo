import { COMPUTER_RECOVERY_REQUIRED_ERROR, COMPUTER_RUNNING_ERROR } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { HomeVersion } from "./home-versions.js";
import {
  HomeRestoreChangedError,
  HomeRestoreRunningError,
  HomeVersionNotFoundError,
  keptHomeRevisions,
  restoreHomeVersion,
} from "./home-versions.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const now = new Date("2026-11-19T15:00:00Z");

/** A save every `everyMs` from `from` up to now, named by when it happened. */
function saves(from: Date, everyMs: number): HomeVersion[] {
  const versions: HomeVersion[] = [];
  for (let at = from.getTime(); at <= now.getTime(); at += everyMs)
    versions.push({ revision: new Date(at).toISOString(), savedAt: new Date(at) });
  return versions;
}

describe("keptHomeRevisions", () => {
  it("keeps the newest saves and each recent day's first", () => {
    const versions = saves(new Date("2026-11-10T00:10:00Z"), 20 * 60_000);
    const current = versions.at(-1)!.revision;

    const kept = [...keptHomeRevisions(versions, current, now)].sort();

    expect(kept).toEqual(
      [
        // The newest two, the current one among them.
        "2026-11-19T14:30:00.000Z",
        "2026-11-19T14:50:00.000Z",
        // The first save of today and of each of the six days before.
        ...[13, 14, 15, 16, 17, 18, 19].map((day) => `2026-11-${day}T00:10:00.000Z`),
      ].sort(),
    );
  });

  it("still keeps a copy from before a damaged home was saved over and over", () => {
    // Saved every twenty minutes, and damaged five hours ago.
    const versions = saves(new Date(now.getTime() - 3 * DAY), 20 * 60_000);
    const damagedAt = now.getTime() - 5 * HOUR;
    const kept = [...keptHomeRevisions(versions, versions.at(-1)!.revision, now)];
    expect(kept.some((revision) => new Date(revision).getTime() < damagedAt)).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(2 + 7);
  });

  it("always keeps the current revision, even an old one a restore made current", () => {
    const versions = saves(new Date(now.getTime() - 30 * DAY), DAY);
    const restored = versions[0]!.revision;
    expect(keptHomeRevisions(versions, restored, now).has(restored)).toBe(true);
  });

  it("forgets days past the window", () => {
    const old = { revision: "old", savedAt: new Date(now.getTime() - 10 * DAY) };
    const recent = saves(new Date(now.getTime() - 2 * HOUR), HOUR);
    expect(keptHomeRevisions([old, ...recent], recent.at(-1)!.revision, now).has("old")).toBe(
      false,
    );
  });
});

describe("restoreHomeVersion", () => {
  const idle: {
    id: string;
    state: string;
    maintenanceId: string | null;
    providerRef: null;
    restorePending: boolean;
    homeStorageId: string | null;
    homeStorageRevision: string;
    homeRevisionAt: Date;
    updatedAt: Date;
  } = {
    id: "computer-1",
    state: "stopped",
    maintenanceId: null,
    providerRef: null,
    restorePending: false,
    homeStorageId: "storage-1",
    homeStorageRevision: "rev-2",
    homeRevisionAt: now,
    updatedAt: now,
  };

  /** A database whose final update loses to a change another transaction committed. */
  function racedBy(after: Partial<typeof idle> | null) {
    const tx = {
      computer: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(idle)
          .mockResolvedValueOnce(after && { ...idle, ...after }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerHomeVersion: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    return { $transaction: (work: (db: typeof tx) => unknown) => work(tx) } as never;
  }

  it.each([null, "update-1"])(
    "requires recovery before any restore writes with maintenance %s",
    async (maintenanceId) => {
      const tx = {
        computer: {
          findUnique: vi.fn().mockResolvedValue({
            ...idle,
            state: "quarantined",
            maintenanceId,
          }),
          updateMany: vi.fn(),
        },
        computerHomeVersion: {
          updateMany: vi.fn(),
          createMany: vi.fn(),
        },
      };
      const db = { $transaction: (work: (db: typeof tx) => unknown) => work(tx) } as never;

      // Even selecting the current revision must not bypass the recovery requirement.
      for (const revision of ["rev-1", "rev-2"]) {
        const restored = restoreHomeVersion(db, "home-1", "storage-1", revision);
        await expect(restored).rejects.toBeInstanceOf(ClientError);
        await expect(restored).rejects.toMatchObject({
          kind: "CONFLICT",
          code: "CONFLICT",
          message: COMPUTER_RECOVERY_REQUIRED_ERROR,
        });
      }
      expect(tx.computer.updateMany).not.toHaveBeenCalled();
      expect(tx.computerHomeVersion.updateMany).not.toHaveBeenCalled();
      expect(tx.computerHomeVersion.createMany).not.toHaveBeenCalled();
    },
  );

  it.each([null, "update-1"])(
    "requires recovery when quarantined meanwhile with maintenance %s",
    async (maintenanceId) => {
      const restored = restoreHomeVersion(
        racedBy({ state: "quarantined", maintenanceId }),
        "home-1",
        "storage-1",
        "rev-1",
      );

      await expect(restored).rejects.toBeInstanceOf(ClientError);
      await expect(restored).rejects.toMatchObject({
        kind: "CONFLICT",
        code: "CONFLICT",
        message: COMPUTER_RECOVERY_REQUIRED_ERROR,
      });
    },
  );

  it.each([
    ["the computer started meanwhile", { state: "running" }, HomeRestoreRunningError],
    ["maintenance began meanwhile", { maintenanceId: "update-1" }, HomeRestoreRunningError],
    ["another restore committed first", { homeStorageRevision: "rev-3" }, HomeRestoreChangedError],
    ["retention cleared the saved files", { homeStorageId: null }, HomeVersionNotFoundError],
    ["the computer was deleted", null, HomeVersionNotFoundError],
  ])("says what changed when %s", async (_, after, expected) => {
    await expect(
      restoreHomeVersion(racedBy(after), "home-1", "storage-1", "rev-1"),
    ).rejects.toBeInstanceOf(expected);
  });

  it("keeps the stop-first code when the computer starts meanwhile", async () => {
    await expect(
      restoreHomeVersion(racedBy({ state: "running" }), "home-1", "storage-1", "rev-1"),
    ).rejects.toMatchObject({ kind: "CONFLICT", code: COMPUTER_RUNNING_ERROR });
  });

  it("does not disclose quarantine when the stored home changed meanwhile", async () => {
    await expect(
      restoreHomeVersion(
        racedBy({ state: "quarantined", homeStorageId: "storage-2" }),
        "home-1",
        "storage-1",
        "rev-1",
      ),
    ).rejects.toBeInstanceOf(HomeVersionNotFoundError);
  });

  it.each(["stopped", "suspended", "error", "running", "maintenance"])(
    "preserves restore eligibility for %s",
    async (state) => {
      const tx = {
        computer: {
          findUnique: vi.fn().mockResolvedValue({
            ...idle,
            state: state === "maintenance" ? "stopped" : state,
            maintenanceId: state === "maintenance" ? "update-1" : null,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        computerHomeVersion: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };
      const db = { $transaction: (work: (db: typeof tx) => unknown) => work(tx) } as never;
      const restored = restoreHomeVersion(db, "home-1", "storage-1", "rev-1");

      if (state === "running" || state === "maintenance") {
        await expect(restored).rejects.toMatchObject({
          kind: "CONFLICT",
          code: COMPUTER_RUNNING_ERROR,
        });
        expect(tx.computer.updateMany).not.toHaveBeenCalled();
      } else {
        await expect(restored).resolves.toBeUndefined();
        expect(tx.computer.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ homeStorageRevision: "rev-1" }),
          }),
        );
      }
    },
  );
});
