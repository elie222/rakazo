import type { Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";

function hasPermissions(stat: Stats, uid: number, gid: number, required: number): boolean {
  const shift = stat.uid === uid ? 6 : stat.gid === gid ? 3 : 0;
  return ((stat.mode >> shift) & required) === required;
}

async function assertWritableEntry(
  target: string,
  root: string,
  uid: number,
  gid: number,
  isRoot = false,
): Promise<void> {
  let stat: Stats;
  try {
    stat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !isRoot) return;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`computer home ${root} does not exist`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    if (isRoot) throw new Error(`computer home ${root} must not be a symbolic link`);
    return;
  }
  if (isRoot && !stat.isDirectory()) {
    throw new Error(`computer home ${root} must be a directory`);
  }

  const required = stat.isDirectory() ? 0b111 : 0b010;
  if (!hasPermissions(stat, uid, gid, required)) {
    throw new Error(
      `computer home entry ${target} is not writable by uid ${uid}; run sudo chown -R ${uid}:${gid} ${JSON.stringify(root)} or use Compose data-init`,
    );
  }
  if (!stat.isDirectory()) return;

  const directory = await opendir(target);
  for await (const entry of directory) {
    await assertWritableEntry(path.join(target, entry.name), root, uid, gid);
  }
}

/** Validate without privileged mutation before a computer receives the home bind mount. */
export async function assertComputerHomeWritable(
  root: string,
  uid: number,
  gid: number,
): Promise<void> {
  await assertWritableEntry(root, root, uid, gid, true);
}
