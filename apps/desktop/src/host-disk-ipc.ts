import { constants, realpathSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain } from "electron";
import {
  createHostDiskGrantStore,
  type HostDiskAuthorizedRoot,
  type HostDiskGrantStore,
} from "./host-disk-grants.js";
import {
  mkdiratChild,
  openatChild,
  type PosixAtFileHandle,
  pathFromOpenFd,
  readdirNamesAt,
  renameatChild,
  unlinkatChild,
} from "./host-disk-posix-at.js";

/** Roots granted via the native folder picker. Renderer-supplied roots are ignored. */
let grantStore: HostDiskGrantStore | null = null;

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
/** Identity-check opens must not block forever on a FIFO in a granted dir. */
const IDENTITY_OPEN = constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0);
/**
 * unlinkat flag to remove directories (AT_REMOVEDIR).
 * Darwin sys/fcntl.h uses 0x80; Linux uses 0x200. A Linux-only constant makes
 * macOS mkdir rollback a no-op and can leave grant-escaping directories behind.
 */
const AT_REMOVEDIR = process.platform === "darwin" ? 0x80 : 0x200;

function grants(): HostDiskGrantStore {
  if (!grantStore) throw new Error("Host disk IPC is not registered");
  return grantStore;
}

function isLexicallyInside(target: string, roots: string[]) {
  const resolved = path.resolve(target);
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), resolved);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  });
}

function rootPaths(roots: HostDiskAuthorizedRoot[]): string[] {
  return roots.map((root) => root.path);
}

async function realGrantedRoots() {
  // Authorize via grant-time device+inode, not a live realpath() of a mutable
  // pathname (which a symlink/dir replacement would redefine).
  const realRoots = await grants().authorizedRealRoots();
  if (realRoots.length === 0) throw new Error("No host folders are granted");
  return realRoots;
}

/**
 * Re-open a grant root and confirm grant-time (dev,ino). Pathnames returned by
 * authorizedRealRoots are mutable after those fds close — a same-user directory
 * swap must not keep authorizing the replacement.
 */
async function openVerifiedGrantRoot(root: HostDiskAuthorizedRoot, flags: number) {
  const handle = await open(root.path, flags | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || String(info.dev) !== root.dev || String(info.ino) !== root.ino) {
      throw new Error("Host path is outside the granted folders");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** Lexical containment plus live (dev,ino) re-check of the covering grant root. */
async function assertInsideAuthorizedRoots(fdReal: string, roots: HostDiskAuthorizedRoot[]) {
  const covering = roots.find((root) => isLexicallyInside(fdReal, [root.path]));
  if (!covering) throw new Error("Host path is outside the granted folders");
  const rootHandle = await openVerifiedGrantRoot(covering, constants.O_RDONLY | DIRECTORY);
  try {
    const liveRoot = await realpathOfFd(rootHandle.fd);
    if (!isLexicallyInside(fdReal, [liveRoot])) {
      throw new Error("Host path is outside the granted folders");
    }
  } finally {
    await rootHandle.close().catch(() => undefined);
  }
}

async function resolveInsideGrants(target: string) {
  const roots = grants().list();
  if (roots.length === 0) throw new Error("No host folders are granted");
  const lexicalTarget = path.resolve(typeof target === "string" ? target : "");
  if (!isLexicallyInside(lexicalTarget, roots)) {
    throw new Error("Host path is outside the granted folders");
  }

  const realRoots = await realGrantedRoots();
  const paths = rootPaths(realRoots);

  let probe = lexicalTarget;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!isLexicallyInside(real, paths)) {
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
      if (!isLexicallyInside(finalPath, paths)) {
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

/**
 * Real path of an open fd for grant checks.
 * Linux: `/proc/self/fd/N`. Darwin: fcntl(F_GETPATH) via pathFromOpenFd.
 * Never `realpath(/dev/fd/N)` — that rejects valid macOS grants.
 */
async function realpathOfFd(fd: number): Promise<string> {
  try {
    return await realpath(pathFromOpenFd(fd));
  } catch {
    throw new Error("Host path is outside the granted folders");
  }
}

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

/**
 * Remove `owned` from a pinned parent dirfd. Try preferred basenames first, then
 * scan the directory so a same-user rename of our temp cannot leave renderer
 * content outside the grant under a new name.
 */
async function unlinkOwnedChildAnywhere(
  dirFd: number,
  owned: FdIdentity,
  preferredNames: string[] = [],
  flags = 0,
) {
  for (const name of preferredNames) {
    try {
      await unlinkIfOwnedChild(dirFd, name, owned, flags);
    } catch {
      // Try the next name / scan.
    }
  }
  let names: string[];
  try {
    names = readdirNamesAt(dirFd);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "." || name === "..") continue;
    try {
      const check = openatChild(dirFd, name, IDENTITY_OPEN);
      let match = false;
      try {
        const st = await check.stat();
        match = sameFdIdentity(st, owned);
      } finally {
        await check.close().catch(() => undefined);
      }
      if (!match) continue;
      // Reuse rename-to-trash unlink so a replacement under this name is not deleted.
      await unlinkIfOwnedChild(dirFd, name, owned, flags);
      return;
    } catch {
      // Skip vanished / raced entries.
    }
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
        child = openatChild(dirFd, name, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
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
 * Empty via the open fd (defeats ENOTEMPTY), remove under the pinned parent
 * (basename + inode scan), then if still present recover the current parent
 * from the fd path (covers rename into another directory).
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
    await unlinkOwnedChildAnywhere(parentFd, owned, [preferredName], AT_REMOVEDIR);
  } catch {
    // Try recovery below.
  }
  try {
    await dirHandle.stat();
  } catch {
    return; // Already gone.
  }
  try {
    const currentPath = pathFromOpenFd(dirHandle.fd);
    const parentPath = path.dirname(currentPath);
    const baseName = path.basename(currentPath);
    const altParent = await open(parentPath, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    try {
      await unlinkOwnedChildAnywhere(altParent.fd, owned, [baseName], AT_REMOVEDIR);
    } finally {
      await altParent.close().catch(() => undefined);
    }
  } catch {
    // Best-effort attributable cleanup only.
  }
}

/**
 * Remove an escaped temp file we still hold open. Prefer the pinned parent
 * (basename + inode scan); if still present, recover the current parent from
 * the fd path so a same-user cross-directory rename cannot leave renderer
 * content outside the grant.
 */
async function unlinkOwnedEscapedFile(
  parentFd: number,
  owned: FdIdentity,
  preferredNames: string[],
  fileHandle: PosixAtFileHandle,
) {
  try {
    await unlinkOwnedChildAnywhere(parentFd, owned, preferredNames);
  } catch {
    // Try recovery below.
  }
  try {
    await fileHandle.stat();
  } catch {
    return; // Already gone.
  }
  try {
    const currentPath = pathFromOpenFd(fileHandle.fd);
    const parentPath = path.dirname(currentPath);
    const baseName = path.basename(currentPath);
    const altParent = await open(parentPath, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    try {
      await unlinkOwnedChildAnywhere(altParent.fd, owned, [baseName, ...preferredNames]);
    } finally {
      await altParent.close().catch(() => undefined);
    }
  } catch {
    // Best-effort attributable cleanup only.
  }
}

/** Last-mile sync containment check (no await) before mkdirat/renameat. */
function assertFdStillInsideRoots(fd: number, roots: HostDiskAuthorizedRoot[]) {
  let fdReal: string;
  try {
    fdReal = realpathSync(pathFromOpenFd(fd));
  } catch {
    throw new Error("Host path is outside the granted folders");
  }
  if (!isLexicallyInside(fdReal, rootPaths(roots))) {
    throw new Error("Host path is outside the granted folders");
  }
}

/** Open + re-validate via fd realpath and covering grant (dev,ino). */
async function openInsideGrants(target: string, flags: number) {
  const realRoots = await realGrantedRoots();
  const resolved = await resolveInsideGrants(target);
  const handle = await open(resolved, flags | NOFOLLOW);
  try {
    await handle.stat();
    const fdReal = await realpathOfFd(handle.fd);
    await assertInsideAuthorizedRoots(fdReal, realRoots);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function mkdirInsideGrants(target: string) {
  const realRoots = await realGrantedRoots();
  const resolved = await resolveInsideGrants(target);
  if (realRoots.some((root) => root.path === resolved)) return resolved;

  const containingRoot = realRoots.find((root) => isLexicallyInside(resolved, [root.path]));
  if (!containingRoot) throw new Error("Host path is outside the granted folders");

  const relative = path.relative(containingRoot.path, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Host path is outside the granted folders");
  }

  const dirFlags = constants.O_RDONLY | DIRECTORY;
  let parentHandle: { fd: number; close: () => Promise<void> } = await openVerifiedGrantRoot(
    containingRoot,
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
        await assertInsideAuthorizedRoots(await realpathOfFd(parentHandle.fd), realRoots);
        // Sync re-check with no await before mkdirat (shrink TOCTOU after async assert).
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
        await assertInsideAuthorizedRoots(fdReal, realRoots);
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
            // Keep `next` open: empty through the fd, then owned unlink under the
            // pinned parent (and current parent if renamed away) so populate /
            // rename races cannot leave a grant-escaping directory behind.
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

export function registerHostDiskIpc() {
  grantStore = createHostDiskGrantStore({
    grantsFilePath: path.join(app.getPath("userData"), "host-disk-grants.json"),
  });

  ipcMain.handle("desktop.hostDisk.pickFolder", async (event: IpcMainInvokeEvent) => {
    await grants().ready;
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const chosen = result.filePaths[0];
    if (!chosen) return null;
    return grants().add(chosen);
  });

  ipcMain.handle("desktop.hostDisk.revokeRoot", async (_event, root: unknown) => {
    await grants().ready;
    if (typeof root !== "string" || root.length === 0) return false;
    // Revoke records intent before/while load and always persists so a late load
    // cannot resurrect the folder.
    return grants().revoke(root);
  });

  ipcMain.handle("desktop.hostDisk.listGrantedRoots", async () => {
    await grants().ready;
    return grants().list();
  });

  ipcMain.handle("desktop.hostDisk.list", async (_event, requestPath: unknown) => {
    await grants().ready;
    const roots = grants().list();
    if (roots.length === 0) throw new Error("No host folders are granted");
    const trimmed = typeof requestPath === "string" ? requestPath.trim() : "";
    if (!trimmed) {
      return roots.map((root) => ({
        path: root,
        kind: "dir" as const,
        size: 0,
      }));
    }
    const realRoots = await realGrantedRoots();
    const dirFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);
    const handle = await openInsideGrants(trimmed, dirFlags);
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory()) throw new Error("Host path is outside the granted folders");
      const fdReal = await realpathOfFd(handle.fd);
      await assertInsideAuthorizedRoots(fdReal, realRoots);
      // Enumerate via the pinned dirfd (fdopendir). Pathname readdir(realpath(fd))
      // or even fdRefPath alone is weaker than dirfd readdir on Darwin; entry
      // opens use openat(dirfd, name) — never /dev/fd/<fd>/child.
      const names = readdirNamesAt(handle.fd);
      const listed: Array<{ path: string; kind: "file" | "dir"; size: number }> = [];
      for (const name of names) {
        if (name === "." || name === "..") continue;
        try {
          const entryHandle = openatChild(handle.fd, name, constants.O_RDONLY | NOFOLLOW);
          try {
            const entryReal = await realpathOfFd(entryHandle.fd);
            try {
              await assertInsideAuthorizedRoots(entryReal, realRoots);
            } catch {
              continue;
            }
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
          // Skip escaping, vanished, or symlink entries.
        }
      }
      return listed.sort((left, right) => left.path.localeCompare(right.path));
    } finally {
      await handle.close();
    }
  });

  ipcMain.handle(
    "desktop.hostDisk.read",
    async (_event, requestPath: unknown, maxBytes: unknown) => {
      await grants().ready;
      const handle = await openInsideGrants(String(requestPath ?? ""), constants.O_RDONLY);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("Host path is not a file");
        if (typeof maxBytes === "number" && info.size > maxBytes) {
          throw new Error(`file exceeds ${maxBytes} bytes`);
        }
        const bytes = await handle.readFile();
        return bytes.toString("base64");
      } finally {
        await handle.close();
      }
    },
  );

  ipcMain.handle(
    "desktop.hostDisk.write",
    async (_event, requestPath: unknown, contentBase64: unknown) => {
      await grants().ready;
      if (typeof contentBase64 !== "string") throw new Error("Missing file content");
      const target = await resolveInsideGrants(String(requestPath ?? ""));
      await mkdirInsideGrants(path.dirname(target));

      const realRoots = await realGrantedRoots();
      const baseName = path.basename(target);
      if (!baseName || baseName === "." || baseName === "..") {
        throw new Error("Host path is outside the granted folders");
      }

      const parentPath = await resolveInsideGrants(path.dirname(target));
      const dirFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);
      const parentHandle = await openInsideGrants(parentPath, dirFlags);
      const tempName = `.rakazo-host-disk-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
      let tempPending = false;
      let tempOwned: FdIdentity | null = null;
      try {
        // openat pins the parent inode. Do not require path.dirname(child) ===
        // a cached parentFdReal: renaming the parent inside the grant updates
        // child realpaths while a stale parent string would false-reject and
        // unlink a contained write.
        await assertInsideAuthorizedRoots(await realpathOfFd(parentHandle.fd), realRoots);

        // Keep the temp fd open until publish/cleanup finishes so an unlink of
        // tempName cannot orphan our inode under a renamed basename outside the grant.
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
          await assertInsideAuthorizedRoots(tempFdReal, realRoots);
          await tempHandle.writeFile(Buffer.from(contentBase64, "base64"));

          // Re-bind the parent through a fresh grant walk before publish. If the
          // pinned parent was moved outside the grant, parentPath no longer names
          // the same inode (or open fails) and we abort without renameat — so
          // renderer content is never committed on the escaped directory.
          const pinnedParent = await parentHandle.stat();
          const publishHandle = await openInsideGrants(parentPath, dirFlags);
          try {
            const liveParent = await publishHandle.stat();
            if (
              String(liveParent.dev) !== String(pinnedParent.dev) ||
              String(liveParent.ino) !== String(pinnedParent.ino)
            ) {
              throw new Error("Host path is outside the granted folders");
            }
            await assertInsideAuthorizedRoots(await realpathOfFd(publishHandle.fd), realRoots);
            // Sync re-check with no await before renameat (shrink TOCTOU after async assert).
            assertFdStillInsideRoots(publishHandle.fd, realRoots);
            renameatChild(publishHandle.fd, tempName, baseName);

            const finalHandle = openatChild(
              publishHandle.fd,
              baseName,
              constants.O_RDONLY | NOFOLLOW,
            );
            let publishedStat: FdIdentity | null = null;
            try {
              publishedStat = await finalHandle.stat();
              await assertInsideAuthorizedRoots(await realpathOfFd(publishHandle.fd), realRoots);
              await assertInsideAuthorizedRoots(await realpathOfFd(finalHandle.fd), realRoots);
              // Publish accepted — temp name is gone.
              tempPending = false;
              tempOwned = null;
            } catch (publishError) {
              // Residual TOCTOU after renameat: never unlink an outside destination
              // by basename (that can destroy unrelated outside data). Roll our
              // inode back to the temp name when baseName still names the file we
              // published, then let inode-checked temp cleanup remove it.
              if (publishedStat) {
                try {
                  const check = openatChild(
                    publishHandle.fd,
                    baseName,
                    constants.O_RDONLY | NOFOLLOW,
                  );
                  try {
                    const checkStat = await check.stat();
                    if (sameFdIdentity(checkStat, publishedStat)) {
                      renameatChild(publishHandle.fd, baseName, tempName);
                    }
                  } finally {
                    await check.close().catch(() => undefined);
                  }
                } catch {
                  // Best-effort rollback only.
                }
                // If rename-back did not clear baseName, remove only our inode —
                // never a replacement that raced in under the same basename.
                try {
                  await unlinkIfOwnedChild(publishHandle.fd, baseName, publishedStat);
                } catch {
                  // Best-effort attributable cleanup only.
                }
              }
              if (publishError instanceof Error) throw publishError;
              throw new Error("Host path is outside the granted folders");
            } finally {
              await finalHandle.close().catch(() => undefined);
            }
          } finally {
            await publishHandle.close().catch(() => undefined);
          }
        } finally {
          if (tempPending && tempOwned) {
            try {
              // Cleanup while tempHandle is still open: parent scan + fd-path
              // parent recovery so a same-user cross-directory rename cannot
              // leave renderer content outside the grant.
              await unlinkOwnedEscapedFile(
                parentHandle.fd,
                tempOwned,
                [tempName, baseName],
                tempHandle,
              );
            } catch {
              // Best-effort cleanup of our temp inode only.
            }
          }
          await tempHandle.close().catch(() => undefined);
        }
      } finally {
        await parentHandle.close().catch(() => undefined);
      }
      return true;
    },
  );
}
