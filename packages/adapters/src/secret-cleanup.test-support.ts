import type { BackgroundJob } from "@rakazo/adapter-kit";
import { vi } from "vitest";
import type { SecretCleanup, SecretCleanupDeps } from "./secret-cleanup.js";
import { retrySecretCleanup } from "./secret-cleanup.js";

/** A queue that keeps each keyed job until it is cancelled, as the cleanup paths see it. */
export function fakeCleanupJobs() {
  const queued = new Map<string, BackgroundJob>();
  const add = async (job: BackgroundJob) => {
    queued.set(job.replaceKey ?? "", job);
  };
  const jobs = {
    enqueue: vi.fn(add),
    enqueueIn: vi.fn((_tx: unknown, job: BackgroundJob) => add(job)),
    enqueueManyIn: vi.fn(async (_tx: unknown, many: readonly BackgroundJob[]) => {
      for (const job of many) await add(job);
    }),
    cancel: vi.fn(async (key: string) => {
      queued.delete(key);
    }),
  };
  /** The queued cleanups, with `due` false while one is still the backup of a direct attempt. */
  const cleanups = () =>
    [...queued.values()].map((job) => ({
      ...(job.payload as SecretCleanup),
      due: !job.availableAt,
    }));
  /** Runs every queued cleanup as the worker would, removing the ones that succeed. */
  const runQueued = async (deps: Pick<SecretCleanupDeps, "prisma" | "secrets">) => {
    for (const [key, job] of [...queued]) {
      await retrySecretCleanup(deps, job.payload as SecretCleanup);
      queued.delete(key);
    }
  };
  return { jobs, queued, cleanups, runQueued };
}
