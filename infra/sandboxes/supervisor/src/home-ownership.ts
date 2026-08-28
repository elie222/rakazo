import { constants, type Stats } from "node:fs";
import { type FileHandle, lchown, lstat, open, opendir, readlink } from "node:fs/promises";
import path from "node:path";
import { COMPUTER_GID, COMPUTER_UID } from "./computer-spec.js";

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function isMissingOrNotDirectory(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR";
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

async function resolveFdPath(fd: number): Promise<string> {
  return readlink(`/proc/self/fd/${fd}`);
}

async function assertFdBeneathRoot(handle: FileHandle, rootPath: string): Promise<void> {
  const currentPath = await resolveFdPath(handle.fd);
  if (!isPathInside(rootPath, currentPath)) {
    throw new Error(
      `computer home ownership escaped validated root ${rootPath}; saw ${currentPath}`,
    );
  }
}

async function lchownIfPresent(target: string, uid: number, gid: number): Promise<void> {
  await lchown(target, uid, gid).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

async function visitDirectory(
  handle: FileHandle,
  rootPath: string,
  uid: number,
  gid: number,
): Promise<void> {
  await assertFdBeneathRoot(handle, rootPath);
  const descriptorPath = `/proc/self/fd/${handle.fd}`;
  const directory = await opendir(descriptorPath);
  for await (const entry of directory) {
    const childPath = path.join(descriptorPath, entry.name);
    let child: FileHandle | undefined;
    try {
      child = await open(childPath, DIRECTORY_OPEN_FLAGS);
    } catch (error) {
      if (!isMissingOrNotDirectory(error)) throw error;
    }
    if (!child) {
      await lchownIfPresent(childPath, uid, gid);
      continue;
    }
    try {
      await assertFdBeneathRoot(child, rootPath);
      await visitDirectory(child, rootPath, uid, gid);
    } finally {
      await child.close();
    }
  }
  await assertFdBeneathRoot(handle, rootPath);
  await handle.chown(uid, gid);
}

function hasPermissions(stat: Stats, uid: number, gid: number, required: number): boolean {
  const shift = stat.uid === uid ? 6 : stat.gid === gid ? 3 : 0;
  return ((stat.mode >> shift) & required) === required;
}

async function assertWritableEntry(
  target: string,
  root: string,
  uid: number,
  gid: number,
): Promise<void> {
  let stat: Stats;
  try {
    stat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;

  const required = stat.isDirectory() ? 0b111 : 0b010;
  if ((stat.isDirectory() || stat.uid !== uid) && !hasPermissions(stat, uid, gid, required)) {
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

/**
 * Compose runs the supervisor as root while computer containers run as uid 1000.
 * When running as root, normalize existing bind-mount contents without following
 * symlinks out of the bot home. Host-run / non-root supervisors leave ownership
 * unchanged.
 */
export async function ensureComputerHomeOwnership(
  root: string,
  uid = COMPUTER_UID,
  gid = COMPUTER_GID,
): Promise<void> {
  if (process.getuid?.() !== 0) return;
  if (process.platform !== "linux") {
    throw new Error("computer home ownership normalization requires Linux");
  }
  const handle = await open(root, DIRECTORY_OPEN_FLAGS);
  try {
    const rootPath = await resolveFdPath(handle.fd);
    await visitDirectory(handle, rootPath, uid, gid);
  } finally {
    await handle.close();
  }
}

/** Fail before container replacement when a host-run supervisor cannot migrate ownership. */
export async function assertComputerHomeWritable(
  root: string,
  uid: number,
  gid: number,
): Promise<void> {
  await assertWritableEntry(root, root, uid, gid);
}

/** Exported for regression coverage of the moved-directory escape check. */
export async function assertOpenedDirectoryBeneathRoot(
  handle: FileHandle,
  rootPath: string,
): Promise<void> {
  await assertFdBeneathRoot(handle, rootPath);
}
