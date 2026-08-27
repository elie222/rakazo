import { lchown, lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { COMPUTER_GID, COMPUTER_UID } from "./computer-spec.js";

/**
 * Compose runs the supervisor as root while computer containers run as uid 1000.
 * Normalize existing bind-mount contents without following symlinks out of the
 * bot home. Host-run supervisors leave ownership unchanged.
 */
export async function ensureComputerHomeOwnership(
  root: string,
  uid = COMPUTER_UID,
  gid = COMPUTER_GID,
): Promise<void> {
  const visit = async (target: string): Promise<void> => {
    const stat = await lstat(target);
    if (stat.isDirectory()) {
      const directory = await opendir(target);
      for await (const entry of directory) {
        const child = path.join(target, entry.name);
        if (entry.isDirectory()) await visit(child);
        else await lchown(child, uid, gid);
      }
    }
    await lchown(target, uid, gid);
  };

  await visit(root);
}
