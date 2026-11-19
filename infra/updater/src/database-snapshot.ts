import { access, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ComposeTarget, ComposeUpdateStep } from "@rakazo/core";
import { composeCopyArgv, composeExecArgv } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type { CommandResult, UpdaterCommandRunner } from "./index.js";
import type { UpdaterConfig } from "./updater-logic.js";

export const SNAPSHOT_STEP_ID = "snapshot";
/** Inside the deployment directory, which Git and the image build both already ignore. */
export const SNAPSHOT_DIRECTORY = "backups/pre-update";
const DATABASE_SERVICE = "postgres";
const CONTAINER_DUMP = "/tmp/rakazo-pre-update.dump";
const SNAPSHOT_FILE = /^\d{8}T\d{6}Z-[A-Za-z0-9_.-]+(\+retry)?\.dump$/;
// An image tag cannot contain "+", so no release's first snapshot can be taken for a retry.
const RETRY_SUFFIX = "+retry";
// Neither name can match SNAPSHOT_FILE, so neither is ever counted or pruned as a snapshot.
const CYCLE_MARKER = ".in-progress";
const PARTIAL_FILE = ".partial";
// A dump of a large database is slow; the copy out of the container is bounded the same way.
const SNAPSHOT_TIMEOUT_MS = 1_800_000;
// Fixed text: the database name and user are read from the container's own environment, so no
// value from a request or the deployment environment reaches this shell.
const DUMP_SCRIPT = [
  "set -e",
  "umask 077",
  `rm -f ${CONTAINER_DUMP}`,
  // Owners and privileges stay in the dump: it is restored into the cluster it came from, and
  // the migrations' revocations must come back with it.
  `pg_dump --format=custom -U "$POSTGRES_USER" -f ${CONTAINER_DUMP} "$POSTGRES_DB"`,
  // A dump that cannot be listed cannot be restored, so it must not count as a snapshot.
  `pg_restore --list ${CONTAINER_DUMP} >/dev/null`,
].join("; ");

/**
 * Puts the snapshot ahead of the recreate: images are already pulled or about to be built, and the
 * `migrate` service that the recreate starts has not touched the schema yet.
 */
export function withSnapshotStep(
  steps: readonly ComposeUpdateStep[],
  enabled: boolean,
): ComposeUpdateStep[] {
  const recreate = steps.findIndex((step) => step.id === "recreate");
  if (!enabled || recreate < 0) return [...steps];
  return [
    ...steps.slice(0, recreate),
    // Several commands and file moves, so the step is run by `snapshotDatabase`, not as one argv.
    { id: SNAPSHOT_STEP_ID, label: "Snapshot the database", command: "docker", args: [] },
    ...steps.slice(recreate),
  ];
}

function snapshotName(fromTag: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replaceAll(/[-:]/g, "");
  return `${stamp}-${fromTag}`;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

interface SnapshotUpdate {
  fromTag: string | null;
}

/**
 * The name, without `.dump`, of the first snapshot taken since an update last succeeded. Whatever
 * has been attempted or rolled back since, a failed attempt's migrations may have run, so that
 * file stays the one clean copy until an update succeeds.
 */
async function readCycle(directory: string): Promise<string | null> {
  let cycle: string;
  try {
    cycle = (await readFile(path.posix.join(directory, CYCLE_MARKER), "utf8")).trim();
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  return SNAPSHOT_FILE.test(`${cycle}.dump`) && !cycle.endsWith(RETRY_SUFFIX) ? cycle : null;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Dumps the database the outgoing release wrote and saves it in the deployment directory. Image
 * recovery never reverses a migration, so this file is what makes going back possible.
 *
 * A cycle runs from a release's first update attempt until an update from it succeeds, however
 * many attempts that takes and whatever each one targets. The first attempt saves
 * `<time>-<tag>.dump`, which no later attempt replaces: a failed attempt's migrations may already
 * have run, so only that file is certain to predate them. A later attempt saves
 * `<time>-<tag>+retry.dump` beside it, replacing the previous one's, so a cycle never holds more
 * than two files. The cycle ends when an update succeeds ({@link endSnapshotCycle}), never on a
 * rollback, which leaves the failed attempt's migrations in place; files of the last
 * `config.databaseSnapshots` cycles are kept. A failure is returned, not thrown, and happens
 * before any service is recreated.
 */
export async function snapshotDatabase(
  config: UpdaterConfig,
  target: ComposeTarget,
  update: SnapshotUpdate,
  run: UpdaterCommandRunner,
  now = new Date(),
): Promise<CommandResult> {
  const options = { cwd: config.deployDir, timeoutMs: SNAPSHOT_TIMEOUT_MS };
  const directory = path.posix.join(config.deployDir, SNAPSHOT_DIRECTORY);
  const partial = path.posix.join(directory, PARTIAL_FILE);
  const exec = (command: readonly string[]) => {
    const invocation = composeExecArgv(target, DATABASE_SERVICE, command);
    return run(invocation.command, invocation.args, options);
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dumped = await exec(["sh", "-c", DUMP_SCRIPT]);
    if (!dumped.ok) return dumped;
    const copy = composeCopyArgv(target, `${DATABASE_SERVICE}:${CONTAINER_DUMP}`, partial);
    const copied = await run(copy.command, copy.args, options);
    if (!copied.ok) return copied;
    await chmod(partial, 0o600);
    const cycle = (await readCycle(directory)) ?? snapshotName(update.fromTag ?? "unknown", now);
    const first = path.posix.join(directory, `${cycle}.dump`);
    // Also true for a new cycle that lands on an existing name: the earlier file is never replaced.
    const retry = await exists(first);
    const file = retry ? path.posix.join(directory, `${cycle}${RETRY_SUFFIX}.dump`) : first;
    await rename(partial, file);
    await writeFile(path.posix.join(directory, CYCLE_MARKER), `${cycle}\n`, { mode: 0o600 });
    await prune(directory, config.databaseSnapshots, cycle);
    const output = retry
      ? `Saved ${file}. An update failed before this one: ${first} is the copy from before that attempt.`
      : `Saved ${file}`;
    return { ok: true, exitCode: 0, stdout: output, output };
  } catch (error) {
    const output = `Could not save the database snapshot: ${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, exitCode: null, stdout: "", output };
  } finally {
    await bestEffort("remove an unfinished database snapshot", rm(partial, { force: true }));
    await bestEffort(
      "remove the database snapshot from the database container",
      exec(["rm", "-f", CONTAINER_DUMP]),
    );
  }
}

/** The update succeeded, so the next snapshot of this release starts a new cycle. */
export async function endSnapshotCycle(config: UpdaterConfig): Promise<void> {
  await rm(path.posix.join(config.deployDir, SNAPSHOT_DIRECTORY, CYCLE_MARKER), { force: true });
}

/** Keeps the files of the newest `keep` cycles. Only files this module named are ever removed. */
async function prune(directory: string, keep: number, current: string) {
  const names = (await readdir(directory)).filter((name) => SNAPSHOT_FILE.test(name));
  const cycleOf = (name: string) => name.replace(/(\+retry)?\.dump$/, "");
  // Stamps sort by time. The cycle just written counts as one of the kept ones wherever its
  // stamp sorts, so a clock set back cannot make an update delete its own snapshot.
  const older = [...new Set(names.map(cycleOf))].filter((cycle) => cycle !== current).sort();
  const kept = new Set([current, ...older.slice(older.length - (keep - 1))]);
  for (const name of names) {
    if (!kept.has(cycleOf(name))) await rm(path.posix.join(directory, name), { force: true });
  }
}
