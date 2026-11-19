import { chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
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
const SNAPSHOT_FILE = /^\d{8}T\d{6}Z-[A-Za-z0-9_.-]+\.dump$/;
const STAMP_LENGTH = "20260101T000000Z".length;
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
  return `${stamp}-${fromTag}.dump`;
}

/**
 * Dumps the database the outgoing release wrote and saves it in the deployment directory, keeping
 * files for the last `config.databaseSnapshots` releases. Image recovery never reverses a migration, so this
 * file is what makes going back to the previous release possible. A failure is returned, not
 * thrown, and happens before any service is recreated.
 */
export async function snapshotDatabase(
  config: UpdaterConfig,
  target: ComposeTarget,
  fromTag: string,
  run: UpdaterCommandRunner,
  now = new Date(),
): Promise<CommandResult> {
  const options = { cwd: config.deployDir, timeoutMs: SNAPSHOT_TIMEOUT_MS };
  const directory = path.posix.join(config.deployDir, SNAPSHOT_DIRECTORY);
  const file = path.posix.join(directory, snapshotName(fromTag, now));
  const partial = `${file}.partial`;
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
    await rename(partial, file);
    await prune(directory, config.databaseSnapshots);
    const output = `Saved ${file}`;
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

/**
 * Keeps snapshots for the `keep` most recently outgoing releases. A release that was snapshotted
 * more than once had an update retried: its first file is the only one certain to predate the
 * failed attempt's migrations and its last is the freshest, so both stay and the ones between go.
 * Only files this module named are ever removed.
 */
async function prune(directory: string, keep: number) {
  // Stamps sort by time, so each release's files are oldest first.
  const names = (await readdir(directory)).filter((name) => SNAPSHOT_FILE.test(name)).sort();
  const byRelease = new Map<string, string[]>();
  for (const name of names) {
    const release = name.slice(STAMP_LENGTH + 1);
    const files = byRelease.get(release) ?? [];
    // Inserted again at the end, which leaves the releases ordered by their newest file.
    byRelease.delete(release);
    byRelease.set(release, [...files, name]);
  }
  const releases = [...byRelease.values()];
  const kept = new Set(releases.slice(-keep).flatMap((files) => [files[0], files.at(-1)]));
  for (const name of releases.flat()) {
    if (!kept.has(name)) await rm(path.posix.join(directory, name), { force: true });
  }
}
