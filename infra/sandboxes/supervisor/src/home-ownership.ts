import { constants } from "node:fs";
import { type FileHandle, lchown, lstat, open, opendir } from "node:fs/promises";
import path from "node:path";
import { COMPUTER_GID, COMPUTER_UID } from "./computer-spec.js";

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function isMissingOrNotDirectory(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR";
}

async function lchownIfPresent(target: string, uid: number, gid: number): Promise<void> {
  await lchown(target, uid, gid).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

async function visitDirectory(handle: FileHandle, uid: number, gid: number): Promise<void> {
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
      await visitDirectory(child, uid, gid);
    } finally {
      await child.close();
    }
  }
  await handle.chown(uid, gid);
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
    await visitDirectory(handle, uid, gid);
  } finally {
    await handle.close();
  }
}

/**
 * Host-run non-root supervisors launch the computer as the supervisor uid/gid.
 * Fail closed when an existing home still contains foreign-owned entries so the
 * bind mount is not silently unwritable. Does not chown (non-root cannot).
 */
export async function assertHostComputerHomeCompatible(
  root: string,
  uid = process.getuid?.(),
  gid = process.getgid?.(),
): Promise<void> {
  if (uid === undefined || gid === undefined || uid === 0) return;

  const visit = async (target: string): Promise<void> => {
    const stat = await lstat(target);
    if (stat.uid !== uid || stat.gid !== gid) {
      throw new Error(
        `computer home ${root} has entries owned by ${stat.uid}:${stat.gid}; host-run containers use ${uid}:${gid}. Fix ownership (chown -R ${uid}:${gid} ${root}) or run via Compose.`,
      );
    }
    if (!stat.isDirectory()) return;
    const directory = await opendir(target);
    for await (const entry of directory) {
      await visit(path.join(target, entry.name));
    }
  };

  await visit(root);
}
