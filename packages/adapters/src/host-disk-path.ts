import { constants, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  mkdiratChild,
  openatChild,
  type PosixAtFileHandle,
  pathFromOpenFd,
  readdirNamesAt,
  renameatChild,
  unlinkatChild,
} from "./host-disk-posix-at.js";

type PathOperations = Pick<typeof path, "isAbsolute" | "relative" | "resolve" | "sep">;

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
/** Identity-check opens must not block forever on a FIFO in a granted dir. */
const IDENTITY_OPEN = constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0);
/**
 * unlinkat flag to remove directories (AT_REMOVEDIR).
 * Darwin sys/fcntl.h uses 0x80; Linux uses 0x200. A Linux-only constant makes
 * macOS mkdir rollback a no-op and can leave grant-escaping directories behind.
 */
const AT_REMOVEDIR = process.platform === "darwin" ? 0x80 : 0x200;

/** Lexical containment (no symlink resolution). */
export function isLexicallyInsideRoots(
  target: string,
  roots: string[],
  pathOperations: PathOperations = path,
) {
  const resolved = pathOperations.resolve(target);
  return roots.some((root) => {
    const relative = pathOperations.relative(pathOperations.resolve(root), resolved);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${pathOperations.sep}`) &&
        !pathOperations.isAbsolute(relative))
    );
  });
}

async function realRootsOf(roots: string[]) {
  if (roots.length === 0) throw new Error("Host path is outside the granted folders");
  const realRoots: string[] = [];
  for (const root of roots.map((item) => path.resolve(item))) {
    try {
      realRoots.push(await realpath(root));
    } catch {
      throw new Error("Host path is outside the granted folders");
    }
  }
  return realRoots;
}

/**
 * Resolve a host path and require it to stay inside granted roots after
 * symlink resolution. For new paths, the nearest existing ancestor must be
 * inside a granted root and the remainder must not escape.
 */
export async function resolveInsideHostRoots(target: string, roots: string[]): Promise<string> {
  const lexicalRoots = roots.map((root) => path.resolve(root));
  const lexicalTarget = path.resolve(target);
  if (!isLexicallyInsideRoots(lexicalTarget, lexicalRoots)) {
    throw new Error("Host path is outside the granted folders");
  }

  const realRoots = await realRootsOf(roots);

  let probe = lexicalTarget;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!isLexicallyInsideRoots(real, realRoots)) {
        throw new Error("Host path is outside the granted folders");
      }
      if (probe === lexicalTarget) return real;
      const rest = path.relative(probe, lexicalTarget);
      if (
        rest === "" ||
        rest === ".." ||
        rest.startsWith(`..${path.sep}`) ||
        path.isAbsolute(rest)
      ) {
        throw new Error("Host path is outside the granted folders");
      }
      const finalPath = path.join(real, rest);
      if (!isLexicallyInsideRoots(finalPath, realRoots)) {
        throw new Error("Host path is outside the granted folders");
      }
      return finalPath;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
      if (code !== "ENOENT") {
        if (error instanceof Error && /outside the granted folders/i.test(error.message)) {
          throw error;
        }
        throw error;
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        throw new Error("Host path is outside the granted folders");
      }
      probe = parent;
    }
  }
}

/** True when a directory entry is a symlink whose real path leaves the roots. */
export async function hostEntryEscapesRoots(entryPath: string, roots: string[]) {
  try {
    const info = await lstat(entryPath);
    if (!info.isSymbolicLink()) {
      await resolveInsideHostRoots(entryPath, roots);
      return false;
    }
    await resolveInsideHostRoots(entryPath, roots);
    return false;
  } catch {
    return true;
  }
}

/**
 * Real path of an open fd for grant checks.
 * Linux uses `/proc/self/fd/N`; Darwin uses fcntl(F_GETPATH). Do not use
 * `realpath(/dev/fd/N)` — on macOS that does not yield the backing path.
 */
export async function realpathOfFd(fd: number): Promise<string> {
  try {
    const fromFd = pathFromOpenFd(fd);
    // Canonicalize so lexical grant compares match realpath(root).
    return await realpath(fromFd);
  } catch {
    throw new Error("Host path is outside the granted folders");
  }
}

/**
 * Path that refers to an open fd itself (for diagnostics / Linux fd walks).
 * Never join child names under this path — macOS cannot traverse `/dev/fd/N/child`.
 * Host-disk listing uses `readdirNamesAt` (fdopendir) instead of readdir on this path.
 */
export function fdRefPath(fd: number) {
  return process.platform === "linux" ? `/proc/self/fd/${fd}` : `/dev/fd/${fd}`;
}

export type OpenInsideHostRootsOptions = {
  /** Test-only: run after resolve and before open (path-swap race). */
  afterResolve?: () => Promise<void>;
  /** Test-only: run after the parent directory fd is pinned, before temp create/rename. */
  afterParentPinned?: () => Promise<void>;
  /** Test-only: run after list pins the directory fd, before enumeration. */
  afterDirPinned?: () => Promise<void>;
};

/**
 * Open a path only if it stays inside granted roots, pinning the fd against
 * symlink path swaps between resolve and open (re-validate via fd realpath).
 */
export async function openInsideHostRoots(
  target: string,
  roots: string[],
  flags: number,
  options?: OpenInsideHostRootsOptions,
) {
  const realRoots = await realRootsOf(roots);
  const resolved = await resolveInsideHostRoots(target, roots);
  if (options?.afterResolve) await options.afterResolve();
  // Open the validated realpath with O_NOFOLLOW so the final component cannot
  // be a symlink. Intermediate swaps are caught by the fd realpath check.
  const handle = await open(resolved, flags | NOFOLLOW);
  try {
    await handle.stat();
    const fdReal = await realpathOfFd(handle.fd);
    if (!isLexicallyInsideRoots(fdReal, realRoots)) {
      throw new Error("Host path is outside the granted folders");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function readFileInsideHostRoots(
  target: string,
  roots: string[],
  options?: { maxBytes?: number; afterResolve?: () => Promise<void> },
) {
  const handle = await openInsideHostRoots(target, roots, constants.O_RDONLY, {
    afterResolve: options?.afterResolve,
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Host path is not a file");
    if (options?.maxBytes !== undefined && info.size > options.maxBytes) {
      throw new Error(`file exceeds ${options.maxBytes} bytes`);
    }
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

/**
 * List a directory inside granted roots. The directory is opened with
 * O_NOFOLLOW and re-validated via fd realpath. Names are read through the
 * pinned dirfd (fdopendir/readdir) — never via pathname readdir of the
 * realpath string, which a post-pin symlink swap could redirect. Each entry
 * is then opened with openat against the same dirfd.
 */
export async function listInsideHostRoots(
  target: string,
  roots: string[],
  options?: OpenInsideHostRootsOptions,
) {
  const realRoots = await realRootsOf(roots);
  const dirFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);
  const handle = await openInsideHostRoots(target, roots, dirFlags, options);
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory()) throw new Error("Host path is outside the granted folders");
    const fdReal = await realpathOfFd(handle.fd);
    if (!isLexicallyInsideRoots(fdReal, realRoots)) {
      throw new Error("Host path is outside the granted folders");
    }
    if (options?.afterDirPinned) await options.afterDirPinned();
    const names = readdirNamesAt(handle.fd);
    const listed: Array<{ path: string; kind: "file" | "dir"; size: number }> = [];
    for (const name of names) {
      if (name === "." || name === "..") continue;
      try {
        const entryHandle = openatChild(handle.fd, name, constants.O_RDONLY | NOFOLLOW);
        try {
          const entryReal = await realpathOfFd(entryHandle.fd);
          if (!isLexicallyInsideRoots(entryReal, realRoots)) continue;
          const info = await entryHandle.stat();
          if (info.isDirectory()) {
            listed.push({ path: entryReal, kind: "dir", size: 0 });
          } else if (info.isFile()) {
            listed.push({ path: entryReal, kind: "file", size: info.size });
          }
        } finally {
          await entryHandle.close();
        }
      } catch {
        // Skip entries that escape, vanish, or are symlinks (O_NOFOLLOW).
      }
    }
    return listed.sort((left, right) => left.path.localeCompare(right.path));
  } finally {
    await handle.close();
  }
}

/**
 * Create directories under granted roots by walking pinned directory fds so a
 * swapped symlink component cannot divert recursive mkdir outside the jail.
 */
type FdIdentity = { dev: unknown; ino: unknown };

function sameFdIdentity(left: FdIdentity, right: FdIdentity) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

/**
 * Unlink `name` only when the dirent still refers to `owned` (dev,ino).
 * Never delete a replacement that raced in under the same basename.
 */
async function unlinkIfOwnedChild(dirFd: number, name: string, owned: FdIdentity, flags = 0) {
  const check = openatChild(dirFd, name, IDENTITY_OPEN);
  try {
    const st = await check.stat();
    if (!sameFdIdentity(st, owned)) return;
  } finally {
    await check.close().catch(() => undefined);
  }
  // Rename to an unguessable name under the pinned dirfd, re-verify (dev,ino),
  // then unlink — avoids deleting a replacement that raced into `name` between
  // stat and unlinkat (basename-only unlink TOCTOU).
  const trash = `.rakazo-unlink-${process.pid}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  try {
    renameatChild(dirFd, name, trash);
  } catch {
    return;
  }
  try {
    const verify = openatChild(dirFd, trash, IDENTITY_OPEN);
    try {
      const st = await verify.stat();
      if (!sameFdIdentity(st, owned)) {
        // Do not rename trash back onto `name` — that can overwrite a replacement
        // that raced in under the basename. Leave the mismatched trash entry.
        return;
      }
    } finally {
      await verify.close().catch(() => undefined);
    }
    unlinkatChild(dirFd, trash, flags);
  } catch {
    // Best-effort attributable cleanup only.
  }
}

/** Last-mile sync containment check (no await) before mkdirat/renameat. */
function assertFdStillInsideRoots(fd: number, roots: string[]) {
  let fdReal: string;
  try {
    fdReal = realpathSync(pathFromOpenFd(fd));
  } catch {
    throw new Error("Host path is outside the granted folders");
  }
  if (!isLexicallyInsideRoots(fdReal, roots)) {
    throw new Error("Host path is outside the granted folders");
  }
}

/**
 * Empty a directory through an open dirfd (NOFOLLOW). Used before AT_REMOVEDIR so
 * a same-user populate during mkdir validation cannot block rollback of an
 * escaped segment we still hold open.
 */
async function emptyDirAt(dirFd: number) {
  let names: string[];
  try {
    names = readdirNamesAt(dirFd);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "." || name === "..") continue;
    try {
      let child: PosixAtFileHandle | null = null;
      try {
        child = openatChild(
          dirFd,
          name,
          constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW,
        );
      } catch {
        try {
          unlinkatChild(dirFd, name, 0);
        } catch {
          // Best-effort.
        }
        continue;
      }
      try {
        await emptyDirAt(child.fd);
      } finally {
        await child.close().catch(() => undefined);
      }
      try {
        unlinkatChild(dirFd, name, AT_REMOVEDIR);
      } catch {
        // Best-effort.
      }
    } catch {
      // Skip vanished / raced entries.
    }
  }
}

/**
 * Roll back a mkdir segment we still hold open after it escaped the grant.
 * Empty via the open fd, remove under the pinned parent, then recover the
 * current parent from the fd path if renamed away.
 */
async function unlinkOwnedEscapedDir(
  parentFd: number,
  owned: FdIdentity,
  preferredName: string,
  dirHandle: PosixAtFileHandle,
) {
  try {
    await emptyDirAt(dirHandle.fd);
  } catch {
    // Best-effort emptying.
  }
  try {
    await unlinkIfOwnedChild(parentFd, preferredName, owned, AT_REMOVEDIR);
  } catch {
    // Try recovery below.
  }
  try {
    await dirHandle.stat();
  } catch {
    return;
  }
  try {
    const currentPath = pathFromOpenFd(dirHandle.fd);
    const altParent = await open(
      path.dirname(currentPath),
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW,
    );
    try {
      await unlinkIfOwnedChild(altParent.fd, path.basename(currentPath), owned, AT_REMOVEDIR);
    } finally {
      await altParent.close().catch(() => undefined);
    }
  } catch {
    // Best-effort attributable cleanup only.
  }
}

export async function mkdirInsideHostRoots(target: string, roots: string[]) {
  const realRoots = await realRootsOf(roots);
  const resolved = await resolveInsideHostRoots(target, roots);
  if (realRoots.some((root) => root === resolved)) return resolved;

  const containingRoot = realRoots.find((root) => isLexicallyInsideRoots(resolved, [root]));
  if (!containingRoot) throw new Error("Host path is outside the granted folders");

  const relative = path.relative(containingRoot, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Host path is outside the granted folders");
  }

  const dirFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);
  let parentHandle: { fd: number; close: () => Promise<void> } = await openInsideHostRoots(
    containingRoot,
    roots,
    dirFlags,
  );
  try {
    for (const segment of relative.split(path.sep)) {
      if (!segment || segment === "." || segment === "..") {
        throw new Error("Host path is outside the granted folders");
      }
      let next: PosixAtFileHandle;
      let createdSegment = false;
      try {
        next = openatChild(parentHandle.fd, segment, dirFlags | NOFOLLOW);
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "";
        if (code !== "ENOENT") throw error;
        // Prove parent is still inside the grant, then mkdirat with no await in
        // between. If a move races after this and mkdir lands outside, the
        // post-open assert below removes the empty segment we created
        // (AT_REMOVEDIR) — undoing our mkdir, not deleting outside write dests.
        if (!isLexicallyInsideRoots(await realpathOfFd(parentHandle.fd), realRoots)) {
          throw new Error("Host path is outside the granted folders");
        }
        assertFdStillInsideRoots(parentHandle.fd, realRoots);
        try {
          mkdiratChild(parentHandle.fd, segment);
          createdSegment = true;
        } catch (mkdirError) {
          const mkdirCode =
            mkdirError && typeof mkdirError === "object" && "code" in mkdirError
              ? String((mkdirError as { code: unknown }).code)
              : "";
          // Concurrent creator won the race — reopen the existing segment.
          if (mkdirCode !== "EEXIST") throw mkdirError;
        }
        // Without a successful open we cannot confirm the mkdir inode — do
        // not unlink by basename (a replacement could be an unrelated dir).
        next = openatChild(parentHandle.fd, segment, dirFlags | NOFOLLOW);
      }
      try {
        const fdReal = await realpathOfFd(next.fd);
        if (!isLexicallyInsideRoots(fdReal, realRoots)) {
          throw new Error("Host path is outside the granted folders");
        }
      } catch (error) {
        let owned: FdIdentity | null = null;
        if (createdSegment) {
          try {
            owned = await next.stat();
          } catch {
            owned = null;
          }
        }
        if (owned) {
          try {
            await unlinkOwnedEscapedDir(parentHandle.fd, owned, segment, next);
          } catch {
            // Best-effort cleanup.
          }
        }
        await next.close().catch(() => undefined);
        throw error;
      }
      await parentHandle.close().catch(() => undefined);
      parentHandle = next;
    }
    return await realpathOfFd(parentHandle.fd);
  } finally {
    await parentHandle.close().catch(() => undefined);
  }
}

export async function writeFileInsideHostRoots(
  target: string,
  roots: string[],
  content: Uint8Array | Buffer | string,
  options?: OpenInsideHostRootsOptions,
) {
  const resolved = await resolveInsideHostRoots(target, roots);
  if (options?.afterResolve) await options.afterResolve();
  await mkdirInsideHostRoots(path.dirname(resolved), roots);

  const realRoots = await realRootsOf(roots);
  const baseName = path.basename(resolved);
  if (!baseName || baseName === "." || baseName === "..") {
    throw new Error("Host path is outside the granted folders");
  }

  // Pin the parent directory inode. Temp create + rename use openat/renameat so
  // a parent path swap to an outside symlink cannot redirect the write (macOS
  // cannot traverse `/dev/fd/<fd>/child`).
  const parentPath = await resolveInsideHostRoots(path.dirname(resolved), roots);
  const dirFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);
  const parentHandle = await openInsideHostRoots(parentPath, roots, dirFlags);
  const tempName = `.rakazo-host-disk-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  let tempPending = false;
  let tempOwned: FdIdentity | null = null;
  try {
    // openat pins the parent inode. Avoid path.dirname(child) === cached
    // parentFdReal checks: an in-grant parent rename updates child realpaths
    // while a stale parent string would false-reject and unlink a valid write.
    if (!isLexicallyInsideRoots(await realpathOfFd(parentHandle.fd), realRoots)) {
      throw new Error("Host path is outside the granted folders");
    }
    if (options?.afterParentPinned) await options.afterParentPinned();
    if (!isLexicallyInsideRoots(await realpathOfFd(parentHandle.fd), realRoots)) {
      throw new Error("Host path is outside the granted folders");
    }

    const tempHandle = openatChild(
      parentHandle.fd,
      tempName,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_TRUNC | NOFOLLOW,
      0o600,
    );
    tempPending = true;
    try {
      tempOwned = await tempHandle.stat();
      const tempFdReal = await realpathOfFd(tempHandle.fd);
      if (!isLexicallyInsideRoots(tempFdReal, realRoots)) {
        throw new Error("Host path is outside the granted folders");
      }
      await tempHandle.writeFile(typeof content === "string" ? content : Buffer.from(content));

      // Sync containment on the pinned parent fd immediately before renameat
      // (no await): if the parent escaped the grant during the async write,
      // abort without publishing. Keep using the pinned fd — reopening by path
      // would break in-grant parent renames and outside path-swap races that
      // the openat pin is meant to survive.
      assertFdStillInsideRoots(parentHandle.fd, realRoots);
      renameatChild(parentHandle.fd, tempName, baseName);

      const finalHandle = openatChild(parentHandle.fd, baseName, constants.O_RDONLY | NOFOLLOW);
      let publishedStat: FdIdentity | null = null;
      try {
        publishedStat = await finalHandle.stat();
        const parentLive = await realpathOfFd(parentHandle.fd);
        const fdReal = await realpathOfFd(finalHandle.fd);
        if (
          !isLexicallyInsideRoots(parentLive, realRoots) ||
          !isLexicallyInsideRoots(fdReal, realRoots)
        ) {
          // Never unlink an outside destination by basename — that can destroy
          // unrelated outside data. Roll our inode back to the temp name when
          // baseName still names the file we published, then let inode-checked
          // temp cleanup remove it.
          try {
            const check = openatChild(parentHandle.fd, baseName, constants.O_RDONLY | NOFOLLOW);
            try {
              const checkStat = await check.stat();
              if (publishedStat && sameFdIdentity(checkStat, publishedStat)) {
                renameatChild(parentHandle.fd, baseName, tempName);
              }
            } finally {
              await check.close().catch(() => undefined);
            }
          } catch {
            // Best-effort rollback only.
          }
          throw new Error("Host path is outside the granted folders");
        }
        // Publish accepted — temp name is gone.
        tempPending = false;
        tempOwned = null;
      } finally {
        await finalHandle.close().catch(() => undefined);
      }
    } catch (error) {
      if (tempPending && tempOwned) {
        try {
          await unlinkIfOwnedChild(parentHandle.fd, tempName, tempOwned);
        } catch {
          // Best-effort.
        }
        try {
          await unlinkIfOwnedChild(parentHandle.fd, baseName, tempOwned);
        } catch {
          // Best-effort.
        }
        // Still open: recover current parent if renamed across directories.
        try {
          await tempHandle.stat();
          const currentPath = pathFromOpenFd(tempHandle.fd);
          const altParent = await open(
            path.dirname(currentPath),
            constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW,
          );
          try {
            await unlinkIfOwnedChild(altParent.fd, path.basename(currentPath), tempOwned);
          } finally {
            await altParent.close().catch(() => undefined);
          }
        } catch {
          // Best-effort attributable cleanup only.
        }
      }
      throw error;
    } finally {
      await tempHandle.close().catch(() => undefined);
    }
  } finally {
    await parentHandle.close().catch(() => undefined);
  }
}
