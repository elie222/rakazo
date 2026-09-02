import {
  close as closeCb,
  fstat as fstatCb,
  readFile as readFileCb,
  readlinkSync,
  writeFile as writeFileCb,
} from "node:fs";
import { promisify } from "node:util";
import koffi from "koffi";

const closeFd = promisify(closeCb);
const fstatFd = promisify(fstatCb);
const readFileFd = promisify(readFileCb) as (fd: number) => Promise<Buffer>;
const writeFileFd = promisify(writeFileCb) as (
  fd: number,
  data: string | Uint8Array,
) => Promise<void>;

/**
 * fd-relative POSIX helpers (openat/mkdirat/renameat/unlinkat/fdopendir).
 *
 * Linux can traverse `/proc/self/fd/<n>/child`, but macOS `/dev/fd/<n>/child`
 * is not a directory walk and fails with ENOTDIR. Host-disk code must use
 * these *at APIs (or equivalent) so pinned directory fds stay valid on Darwin.
 *
 * Listing must also stay on the pinned dirfd: pathname `readdir(realpath(fd))`
 * can follow a replaced symlink and disclose names outside the grant.
 */

type PosixAtApi = {
  openat: (dirfd: number, pathname: string, flags: number, mode: number) => number;
  mkdirat: (dirfd: number, pathname: string, mode: number) => number;
  renameat: (olddirfd: number, oldpath: string, newdirfd: number, newpath: string) => number;
  unlinkat: (dirfd: number, pathname: string, flags: number) => number;
  dup: (fd: number) => number;
  close: (fd: number) => number;
  fdopendir: (fd: number) => unknown;
  readdir: (dir: unknown) => unknown;
  closedir: (dir: unknown) => number;
  memcpy: (dest: Buffer, src: unknown, n: number) => unknown;
};

let cached: PosixAtApi | null | undefined;

function errnoCode(): string {
  const errno = koffi.errno();
  switch (errno) {
    case 2:
      return "ENOENT";
    case 13:
      return "EACCES";
    case 17:
      return "EEXIST";
    case 20:
      return "ENOTDIR";
    case 40:
      // Linux ELOOP
      return "ELOOP";
    case 62:
      // Darwin ELOOP
      return "ELOOP";
    case 63:
      // Darwin ENAMETOOLONG / vary — treat as generic
      return "EINVAL";
    default:
      return "EINVAL";
  }
}

function fail(code: string, message: string): never {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  throw error;
}

function assertLeafName(name: string) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    fail("EINVAL", "Host path is outside the granted folders");
  }
}

function loadPosixAt(): PosixAtApi {
  if (cached === null) fail("ENOSYS", "POSIX *at APIs unavailable");
  if (cached) return cached;
  if (process.platform === "win32") {
    cached = null;
    fail("ENOSYS", "POSIX *at APIs unavailable");
  }
  try {
    const lib =
      process.platform === "darwin" ? koffi.load("libSystem.B.dylib") : koffi.load("libc.so.6");
    koffi.opaque("DIR");
    cached = {
      openat: lib.func("int openat(int dirfd, const char *pathname, int flags, uint32_t mode)"),
      mkdirat: lib.func("int mkdirat(int dirfd, const char *pathname, uint32_t mode)"),
      renameat: lib.func(
        "int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath)",
      ),
      unlinkat: lib.func("int unlinkat(int dirfd, const char *pathname, int flags)"),
      dup: lib.func("int dup(int oldfd)"),
      close: lib.func("int close(int fd)"),
      fdopendir: lib.func("DIR *fdopendir(int fd)"),
      readdir: lib.func("void *readdir(DIR *dirp)"),
      closedir: lib.func("int closedir(DIR *dirp)"),
      memcpy: lib.func("void *memcpy(_Out_ uint8 *dest, const void *src, size_t n)"),
    };
    return cached;
  } catch {
    cached = null;
    fail("ENOSYS", "POSIX *at APIs unavailable");
  }
}

/** Duck-typed FileHandle surface used by host-disk path helpers. */
export function fileHandleFromFd(fd: number) {
  return {
    fd,
    stat: (opts?: { bigint?: boolean }) => fstatFd(fd, opts as never),
    readFile: () => readFileFd(fd),
    writeFile: (data: string | Uint8Array) => writeFileFd(fd, data),
    close: () => closeFd(fd),
  };
}

export type PosixAtFileHandle = ReturnType<typeof fileHandleFromFd>;

/** Darwin fcntl(F_GETPATH): path of the open fd's inode (not /dev/fd). */
const F_GETPATH = 50;
const MAXPATHLEN = 1024;

type DarwinPathApi = {
  fcntlGetPath: (fd: number, cmd: number, buf: Buffer) => number;
};

let darwinPathCached: DarwinPathApi | null | undefined;

function loadDarwinPathApi(): DarwinPathApi {
  if (darwinPathCached === null) fail("ENOSYS", "fcntl F_GETPATH unavailable");
  if (darwinPathCached) return darwinPathCached;
  try {
    const lib = koffi.load("libSystem.B.dylib");
    darwinPathCached = {
      fcntlGetPath: lib.func("int fcntl(int fd, int cmd, _Out_ uint8_t *buf)"),
    };
    return darwinPathCached;
  } catch {
    darwinPathCached = null;
    fail("ENOSYS", "fcntl F_GETPATH unavailable");
  }
}

/**
 * Absolute path for an open fd.
 * Linux: readlink `/proc/self/fd/N`. Darwin: fcntl(F_GETPATH). Never use
 * `realpath(/dev/fd/N)` for grant checks — on macOS that does not yield the
 * backing filesystem path.
 */
export function pathFromOpenFd(fd: number): string {
  if (process.platform === "darwin") {
    const api = loadDarwinPathApi();
    const buf = Buffer.alloc(MAXPATHLEN);
    const rc = api.fcntlGetPath(fd, F_GETPATH, buf);
    if (rc === -1) fail(errnoCode(), "fcntl F_GETPATH failed");
    const end = buf.indexOf(0);
    // Keep the NUL-bounded path as-is. Trimming would break grants whose
    // real path legitimately ends (or begins) with whitespace.
    const resolved = buf.toString("utf8", 0, end === -1 ? buf.length : end);
    if (!resolved.startsWith("/")) fail("EINVAL", "fcntl F_GETPATH returned no path");
    return resolved;
  }
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "EINVAL";
      fail(code, "readlink /proc/self/fd failed");
    }
  }
  fail("ENOSYS", "pathFromOpenFd unsupported on this platform");
}

export function openatChild(
  dirFd: number,
  name: string,
  flags: number,
  mode = 0,
): PosixAtFileHandle {
  assertLeafName(name);
  const api = loadPosixAt();
  const fd = api.openat(dirFd, name, flags, mode);
  if (fd < 0) fail(errnoCode(), `openat failed for ${name}`);
  return fileHandleFromFd(fd);
}

export function mkdiratChild(dirFd: number, name: string, mode = 0o755) {
  assertLeafName(name);
  const api = loadPosixAt();
  const rc = api.mkdirat(dirFd, name, mode);
  if (rc !== 0) fail(errnoCode(), `mkdirat failed for ${name}`);
}

export function renameatChild(dirFd: number, fromName: string, toName: string) {
  assertLeafName(fromName);
  assertLeafName(toName);
  const api = loadPosixAt();
  const rc = api.renameat(dirFd, fromName, dirFd, toName);
  if (rc !== 0) fail(errnoCode(), `renameat failed for ${fromName} -> ${toName}`);
}

export function unlinkatChild(dirFd: number, name: string, flags = 0) {
  assertLeafName(name);
  const api = loadPosixAt();
  const rc = api.unlinkat(dirFd, name, flags);
  if (rc !== 0) fail(errnoCode(), `unlinkat failed for ${name}`);
}

/** Offset of `d_name` in the platform `struct dirent` (no koffi padding). */
function direntNameOffset() {
  // Linux glibc: ino64 + off64 + reclen + type → 19
  // Darwin: ino + seekoff + reclen + namlen + type → 21
  return process.platform === "darwin" ? 21 : 19;
}

function readDirentName(api: PosixAtApi, ent: unknown): string {
  const nameOffset = direntNameOffset();
  const maxName = process.platform === "darwin" ? 1024 : 256;
  // d_reclen includes trailing alignment padding (8-byte on Linux, 4-byte on Darwin).
  // A 255-byte Linux name is 19+255+1=275 before pad → d_reclen 280.
  const align = process.platform === "darwin" ? 4 : 8;
  const maxReclen = Math.ceil((nameOffset + maxName) / align) * align;
  // d_reclen is a uint16 at offset 16 on both Linux glibc and Darwin dirent layouts.
  const header = Buffer.alloc(18);
  api.memcpy(header, ent, header.length);
  const reclen = header.readUInt16LE(16);
  if (reclen < nameOffset + 1 || reclen > maxReclen) {
    fail("EINVAL", "dirent d_reclen out of range");
  }
  const buf = Buffer.alloc(reclen);
  api.memcpy(buf, ent, reclen);
  let end = nameOffset;
  while (end < buf.length && buf[end] !== 0) end += 1;
  return buf.subarray(nameOffset, end).toString("utf8");
}

/**
 * Enumerate leaf names through a pinned directory fd (fdopendir/readdir).
 * Does not re-open a mutable pathname, so a post-pin path→symlink swap cannot
 * disclose names outside the grant.
 */
export function readdirNamesAt(dirFd: number): string[] {
  const api = loadPosixAt();
  const dupFd = api.dup(dirFd);
  if (dupFd < 0) fail(errnoCode(), "dup failed for directory fd");
  const dir = api.fdopendir(dupFd);
  if (!dir) {
    api.close(dupFd);
    fail(errnoCode(), "fdopendir failed for directory fd");
  }
  try {
    const names: string[] = [];
    for (;;) {
      const ent = api.readdir(dir);
      if (!ent) break;
      const name = readDirentName(api, ent);
      if (!name || name === "." || name === "..") continue;
      if (name.includes("/") || name.includes("\0")) continue;
      names.push(name);
    }
    return names;
  } finally {
    api.closedir(dir);
  }
}

/** True when fd-relative *at syscalls can be used (non-Windows). */
export function posixAtAvailable() {
  if (process.platform === "win32") return false;
  try {
    loadPosixAt();
    return true;
  } catch {
    return false;
  }
}
