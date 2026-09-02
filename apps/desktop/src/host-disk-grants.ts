import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathFromOpenFd } from "./host-disk-posix-at.js";

/**
 * Main-process grant set with load/revoke serialization so a revoke cannot be
 * resurrected by a late grants-file load. Grant identity is path + device/inode
 * captured at add time so replacing the pathname with a symlink (or a different
 * directory) cannot redefine authorization.
 */
/** Verified grant root: pathname plus grant-time identity for IPC re-checks. */
export type HostDiskAuthorizedRoot = {
  path: string;
  dev: string;
  ino: string;
};

export type HostDiskGrantStore = {
  /** Resolves when the initial load has finished. Handlers must await this. */
  readonly ready: Promise<void>;
  list(): string[];
  add(root: string): Promise<string>;
  revoke(root: string): Promise<boolean>;
  hasGrantCovering(target: string): boolean;
  /**
   * Grant roots whose on-disk device+inode still match grant time.
   * Symlink (or directory) replacement of a grant pathname yields no root.
   * Paths come from the verified open fd and are re-confirmed with O_NOFOLLOW
   * (never string realpath, which can follow a post-derivation symlink swap).
   * Callers must re-check `dev`/`ino` when opening — pathnames alone are mutable
   * after these descriptors are closed.
   */
  authorizedRealRoots(): Promise<HostDiskAuthorizedRoot[]>;
};

export type HostDiskGrantStoreOptions = {
  grantsFilePath: string;
  /** Start loading immediately (default true). */
  autoload?: boolean;
  /**
   * Test-only: after identity is verified on the open grant fd, before the
   * allowlist path is taken from that fd (path-swap race).
   */
  afterAuthorizedIdentityVerified?: () => Promise<void>;
  /**
   * Test-only: after pathFromOpenFd returns, before the path is confirmed via
   * O_NOFOLLOW reopen (pathname→symlink race on the fd-derived string).
   */
  afterAuthorizedFdPathDerived?: () => Promise<void>;
};

type GrantRecord = {
  path: string;
  /** File-system device id at grant time (stringified for JSON stability). */
  dev: string;
  /** Inode at grant time (stringified for JSON stability). */
  ino: string;
};

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

function isGrantRecord(value: unknown): value is GrantRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === "string" &&
    record.path.length > 0 &&
    typeof record.dev === "string" &&
    typeof record.ino === "string"
  );
}

function grantPathFromPersisted(item: unknown): string | null {
  if (typeof item === "string" && item.length > 0) return path.resolve(item);
  if (isGrantRecord(item)) return path.resolve(item.path);
  return null;
}

async function captureGrantIdentity(root: string): Promise<GrantRecord> {
  const candidate = path.resolve(root);
  // Open first with O_NOFOLLOW|O_DIRECTORY. Do not realpath() then open — a
  // same-user directory swap between those steps would persist the replacement's
  // device+inode as the grant identity.
  const handle = await open(candidate, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) {
      throw new Error("Host path is outside the granted folders");
    }
    const fdPath = pathFromOpenFd(handle.fd);
    // Confirm the fd-derived pathname still names this inode without following
    // a symlink (same pattern as authorizedRealRoots).
    const confirmed = await open(fdPath, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    try {
      const confirmedInfo = await confirmed.stat();
      if (
        String(confirmedInfo.dev) !== String(info.dev) ||
        String(confirmedInfo.ino) !== String(info.ino)
      ) {
        throw new Error("Host path is outside the granted folders");
      }
      return {
        path: pathFromOpenFd(confirmed.fd),
        dev: String(info.dev),
        ino: String(info.ino),
      };
    } finally {
      await confirmed.close().catch(() => undefined);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function createHostDiskGrantStore(options: HostDiskGrantStoreOptions): HostDiskGrantStore {
  /** Active grants keyed by resolved pathname. */
  const grantedRoots = new Map<string, GrantRecord>();
  /** Paths revoked before or during load; load must not re-add them. */
  const revokedRoots = new Set<string>();
  let ready = Promise.resolve();
  /** Serialize mutate+persist so overlapping add/revoke cannot reorder disk writes. */
  let persistChain: Promise<unknown> = Promise.resolve();

  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = persistChain.then(fn, fn);
    persistChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function save() {
    await mkdir(path.dirname(options.grantsFilePath), { recursive: true });
    const records = [...grantedRoots.values()].sort((a, b) => a.path.localeCompare(b.path));
    await writeFile(options.grantsFilePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }

  async function load() {
    try {
      const raw = JSON.parse(await readFile(options.grantsFilePath, "utf8")) as unknown;
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        let record: GrantRecord;
        try {
          if (typeof item === "string" && item.length > 0) {
            // Legacy path-only entries: capture identity now, or skip if gone.
            record = await captureGrantIdentity(item);
          } else if (isGrantRecord(item)) {
            record = {
              path: path.resolve(item.path),
              dev: item.dev,
              ino: item.ino,
            };
          } else {
            continue;
          }
        } catch {
          continue;
        }
        if (revokedRoots.has(record.path)) continue;
        try {
          if (revokedRoots.has(await realpath(record.path))) continue;
        } catch {
          // Keep the stored lexical path when the directory is temporarily missing.
        }
        // Re-check after awaits so a revoke that landed mid-load still wins.
        if (revokedRoots.has(record.path)) continue;
        grantedRoots.set(record.path, record);
      }
    } catch {
      // First run or unreadable file: empty grant set.
    }
  }

  async function rememberRevoked(root: string) {
    const resolved = path.resolve(root);
    revokedRoots.add(resolved);
    try {
      revokedRoots.add(await realpath(resolved));
    } catch {
      // Path may already be gone.
    }
  }

  if (options.autoload !== false) {
    ready = load();
  }

  return {
    get ready() {
      return ready;
    },
    list() {
      return [...grantedRoots.keys()].sort((left, right) => left.localeCompare(right));
    },
    async add(root: string) {
      await ready;
      return serialized(async () => {
        const record = await captureGrantIdentity(root);
        revokedRoots.delete(record.path);
        grantedRoots.set(record.path, record);
        await save();
        return record.path;
      });
    },
    async revoke(root: string) {
      // Record intent before waiting on load so a concurrent load cannot revive it.
      const lexical = path.resolve(root);
      const wasInMemory = grantedRoots.has(lexical);
      // Peek the grants file before we wait on load so a disk-backed root that is
      // not yet in memory still counts as a successful revoke (without treating
      // every unknown path as success via revokedRoots.has after rememberRevoked).
      let listedOnDisk = false;
      try {
        const raw = JSON.parse(await readFile(options.grantsFilePath, "utf8")) as unknown;
        if (Array.isArray(raw)) {
          listedOnDisk = raw.some((item) => grantPathFromPersisted(item) === lexical);
        }
      } catch {
        // Missing or unreadable grants file: treat as not listed.
      }
      await rememberRevoked(root);
      await ready;
      return serialized(async () => {
        const resolved = path.resolve(root);
        let removed = grantedRoots.delete(resolved);
        try {
          removed = grantedRoots.delete(await realpath(resolved)) || removed;
        } catch {
          // Root may already be gone from disk.
        }
        // Always persist after revoke so a no-op in-memory miss still clears disk.
        await save();
        return removed || wasInMemory || listedOnDisk;
      });
    },
    hasGrantCovering(target: string) {
      const resolved = path.resolve(target);
      return [...grantedRoots.keys()].some((root) => {
        const relative = path.relative(path.resolve(root), resolved);
        return (
          relative === "" ||
          (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        );
      });
    },
    async authorizedRealRoots() {
      await ready;
      const realRoots: HostDiskAuthorizedRoot[] = [];
      for (const record of grantedRoots.values()) {
        try {
          // O_NOFOLLOW: if the grant pathname became a symlink, open fails.
          const handle = await open(record.path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
          try {
            const info = await handle.stat();
            if (!info.isDirectory()) continue;
            if (String(info.dev) !== record.dev || String(info.ino) !== record.ino) {
              // Pathname now names a different directory than the one granted.
              continue;
            }
            if (options.afterAuthorizedIdentityVerified) {
              await options.afterAuthorizedIdentityVerified();
            }
            // Path of the verified inode via the open fd (not record.path).
            const fdPath = pathFromOpenFd(handle.fd);
            if (options.afterAuthorizedFdPathDerived) {
              await options.afterAuthorizedFdPathDerived();
            }
            // Confirm the fd-derived pathname still names the same inode without
            // following a symlink. Do not realpath() the string — that can follow
            // a post-derivation pathname→symlink swap into an ungranted tree.
            const confirmed = await open(fdPath, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
            try {
              const confirmedInfo = await confirmed.stat();
              if (
                String(confirmedInfo.dev) !== record.dev ||
                String(confirmedInfo.ino) !== record.ino
              ) {
                continue;
              }
              realRoots.push({
                path: pathFromOpenFd(confirmed.fd),
                dev: record.dev,
                ino: record.ino,
              });
            } finally {
              await confirmed.close().catch(() => undefined);
            }
          } finally {
            await handle.close().catch(() => undefined);
          }
        } catch {
          // Missing, swapped to symlink, or otherwise unverifiable: skip.
        }
      }
      return realRoots;
    },
  };
}
