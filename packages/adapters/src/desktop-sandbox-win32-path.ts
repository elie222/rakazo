import {
  close as closeCb,
  closeSync,
  fchmod as fchmodCb,
  fstat as fstatCb,
  ftruncate as ftruncateCb,
  writeFile as writeFileCb,
} from "node:fs";
import { promisify } from "node:util";
import koffi from "koffi";

const closeFd = promisify(closeCb);
const fchmodFd = promisify(fchmodCb);
const fstatFd = promisify(fstatCb);
const ftruncateFd = promisify(ftruncateCb);
const writeFileFd = promisify(writeFileCb) as (
  fd: number,
  data: string | Uint8Array,
) => Promise<void>;

const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_DIRECTORY_FILE = 0x00000001;
const FILE_NON_DIRECTORY_FILE = 0x00000040;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
const FILE_OPEN_REPARSE_POINT = 0x00200000;
const OBJ_CASE_INSENSITIVE = 0x00000040;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const SYNCHRONIZE = 0x00100000;
const FILE_SHARE_ALL = 0x00000007;
const FILE_ATTRIBUTE_NORMAL = 0x00000080;
const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
const O_RDWR_BINARY = 0x8002;
/** NTSTATUS 0xC0000035 as signed int32 */
const STATUS_OBJECT_NAME_COLLISION = -1073741771;
/** NTSTATUS 0xC0000034 as signed int32 */
const STATUS_OBJECT_NAME_NOT_FOUND = -1073741772;
/** NTSTATUS 0xC000003A as signed int32 */
const STATUS_OBJECT_PATH_NOT_FOUND = -1073741763;

function escapeWorkspace(): never {
  throw new Error("Path escapes the computer workspace");
}

type NtFns = {
  NtCreateFile: koffi.KoffiFunction;
  RtlInitUnicodeString: koffi.KoffiFunction;
  getOsFhandle: koffi.KoffiFunction;
  openOsFhandle: koffi.KoffiFunction;
  CloseHandle: koffi.KoffiFunction;
  GetFinalPathNameByHandleW: koffi.KoffiFunction;
  objectAttributesSize: number;
};

let cached: NtFns | undefined | null;

/** True when real Win32 NT APIs loaded (false on Linux hosts that only mock win32). */
export function win32NtRelativeAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    nt();
    return true;
  } catch {
    cached = null;
    return false;
  }
}

function nt(): NtFns {
  if (cached === null) throw new Error("Win32 NT APIs unavailable");
  if (cached) return cached;
  const ntdll = koffi.load("ntdll.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const msvcrt = koffi.load("msvcrt.dll");

  koffi.struct("UNICODE_STRING", {
    Length: "uint16_t",
    MaximumLength: "uint16_t",
    Buffer: "void *",
  });
  const OBJECT_ATTRIBUTES = koffi.struct("OBJECT_ATTRIBUTES", {
    Length: "uint32_t",
    RootDirectory: "void *",
    ObjectName: "UNICODE_STRING *",
    Attributes: "uint32_t",
    SecurityDescriptor: "void *",
    SecurityQualityOfService: "void *",
  });
  koffi.struct("IO_STATUS_BLOCK", {
    Status: "intptr_t",
    Information: "uintptr_t",
  });

  cached = {
    NtCreateFile: ntdll.func(
      "int32_t __stdcall NtCreateFile(_Out_ void **FileHandle, uint32_t DesiredAccess, OBJECT_ATTRIBUTES *ObjectAttributes, IO_STATUS_BLOCK *IoStatusBlock, void *AllocationSize, uint32_t FileAttributes, uint32_t ShareAccess, uint32_t CreateDisposition, uint32_t CreateOptions, void *EaBuffer, uint32_t EaLength)",
    ),
    RtlInitUnicodeString: ntdll.func(
      "void __stdcall RtlInitUnicodeString(_Out_ UNICODE_STRING *DestinationString, void *SourceString)",
    ),
    getOsFhandle: msvcrt.func("intptr_t __cdecl _get_osfhandle(int fd)"),
    openOsFhandle: msvcrt.func("int __cdecl _open_osfhandle(intptr_t handle, int flags)"),
    CloseHandle: kernel32.func("int __stdcall CloseHandle(void *hObject)"),
    GetFinalPathNameByHandleW: kernel32.func(
      "uint32_t __stdcall GetFinalPathNameByHandleW(void *hFile, void *lpszFilePath, uint32_t cchFilePath, uint32_t dwFlags)",
    ),
    objectAttributesSize: koffi.sizeof(OBJECT_ATTRIBUTES),
  };
  return cached;
}

/**
 * Resolve the current filesystem path of an open Windows file/directory handle.
 * After a rename/junction swap of the original pathname, this still returns the
 * path of the held inode.
 */
export function pathFromDirectoryFd(fd: number): string {
  const api = nt();
  const handle = api.getOsFhandle(fd) as number | bigint;
  if (handle === -1n || handle === -1) escapeWorkspace();

  const flags = 0; // VOLUME_NAME_DOS
  const size = api.GetFinalPathNameByHandleW(handle, null, 0, flags) as number;
  if (size === 0) escapeWorkspace();

  const buf = Buffer.alloc((size + 1) * 2);
  const written = api.GetFinalPathNameByHandleW(handle, buf, size + 1, flags) as number;
  if (written === 0) escapeWorkspace();

  let resolved = buf.toString("utf16le", 0, written * 2);
  if (resolved.startsWith("\\\\?\\UNC\\"))
    resolved = `\\\\${resolved.slice("\\\\?\\UNC\\".length)}`;
  else if (resolved.startsWith("\\\\?\\")) resolved = resolved.slice("\\\\?\\".length);
  return resolved;
}

function assertLeafName(name: string) {
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) escapeWorkspace();
}

function ntCreateRelative(
  parentFd: number,
  name: string,
  createDisposition: number,
  createOptions: number,
  fileAttributes: number,
): { fd: number; status: number } {
  assertLeafName(name);
  const api = nt();
  const root = api.getOsFhandle(parentFd) as number | bigint;
  if (root === -1 || root === -1n) escapeWorkspace();

  const nameBuf = Buffer.from(`${name}\0`, "utf16le");
  const uni = {};
  api.RtlInitUnicodeString(uni, nameBuf);

  const objectAttributes = {
    Length: api.objectAttributesSize,
    RootDirectory: root,
    ObjectName: uni,
    Attributes: OBJ_CASE_INSENSITIVE,
    SecurityDescriptor: null,
    SecurityQualityOfService: null,
  };
  const ioStatus = {};
  const handleOut: Array<unknown> = [null];
  const status = api.NtCreateFile(
    handleOut,
    GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE,
    objectAttributes,
    ioStatus,
    null,
    fileAttributes,
    FILE_SHARE_ALL,
    createDisposition,
    createOptions,
    null,
    0,
  ) as number;

  if (status !== 0) return { fd: -1, status };

  const handle = handleOut[0];
  if (handle == null) escapeWorkspace();
  const fd = api.openOsFhandle(handle as number | bigint, O_RDWR_BINARY) as number;
  if (fd < 0) {
    api.CloseHandle(handle as number | bigint);
    escapeWorkspace();
  }
  return { fd, status: 0 };
}

/** Duck-typed FileHandle surface used by desktop-sandbox writes. */
export function fileHandleFromFd(fd: number) {
  return {
    fd,
    stat: (opts?: { bigint?: boolean }) => fstatFd(fd, opts as never),
    truncate: (len = 0) => ftruncateFd(fd, len),
    writeFile: (data: string | Uint8Array) => writeFileFd(fd, data),
    chmod: (mode: number) => fchmodFd(fd, mode),
    close: () => closeFd(fd),
  };
}

export type Win32FileHandle = ReturnType<typeof fileHandleFromFd>;

export function openExistingChildViaDirectoryFdWin32(parentFd: number, name: string) {
  const { fd, status } = ntCreateRelative(
    parentFd,
    name,
    FILE_OPEN,
    FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
    FILE_ATTRIBUTE_NORMAL,
  );
  if (status === STATUS_OBJECT_NAME_NOT_FOUND || status === STATUS_OBJECT_PATH_NOT_FOUND) {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  if (status !== 0) escapeWorkspace();
  return fileHandleFromFd(fd);
}

export function createExclusiveChildViaDirectoryFdWin32(parentFd: number, name: string) {
  const { fd, status } = ntCreateRelative(
    parentFd,
    name,
    FILE_CREATE,
    FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
    FILE_ATTRIBUTE_NORMAL,
  );
  if (status === STATUS_OBJECT_NAME_COLLISION) {
    const err = new Error("EEXIST") as NodeJS.ErrnoException;
    err.code = "EEXIST";
    throw err;
  }
  if (status !== 0) escapeWorkspace();
  return fileHandleFromFd(fd);
}

/** Creates a child directory relative to the parent fd. Returns a path for cleanup when available. */
export function mkdirChildViaDirectoryFdWin32(parentFd: number, name: string): string | undefined {
  const { fd, status } = ntCreateRelative(
    parentFd,
    name,
    FILE_CREATE,
    FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
    FILE_ATTRIBUTE_DIRECTORY,
  );
  if (status === STATUS_OBJECT_NAME_COLLISION) {
    const err = new Error("EEXIST") as NodeJS.ErrnoException;
    err.code = "EEXIST";
    throw err;
  }
  if (status !== 0) escapeWorkspace();
  let createdPath: string | undefined;
  try {
    createdPath = pathFromDirectoryFd(fd);
  } catch {
    createdPath = undefined;
  }
  closeSync(fd);
  return createdPath;
}

export function openChildDirectoryViaDirectoryFdWin32(parentFd: number, name: string) {
  const { fd, status } = ntCreateRelative(
    parentFd,
    name,
    FILE_OPEN,
    FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
    FILE_ATTRIBUTE_DIRECTORY,
  );
  if (status !== 0) escapeWorkspace();
  return fileHandleFromFd(fd);
}
