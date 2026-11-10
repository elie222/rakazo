import { createSha256 } from "./backup-crypto";
import type { WebdavBackupErrorCode } from "./webdav-backup";
import { basicAuthHeader, WebdavBackupError } from "./webdav-backup";

/**
 * Native transfers for WebDAV backup. `expo-file-system` is imported
 * dynamically, so importing this module never pulls the native module into
 * tests or into a bundle that does not use backup.
 *
 * Two transport notes, both worth knowing before review:
 *
 * 1. The export is a POST (the backup password rides in the POST body with
 *    the one-time account token), and expo-file-system's DownloadTask is
 *    GET-only, so it cannot carry that body. The export instead streams
 *    through the response body into the file's writable stream in bounded
 *    chunks, feeding the SHA-256 as it goes — JS memory stays flat. If the
 *    server later answers a short-lived GET download URL for a POST export,
 *    this is the one function to swap for a DownloadTask.
 *
 * 2. The import route takes the zip as `application/zip`, so there is no
 *    body field for the backup password. It travels in one header,
 *    BACKUP_PASSWORD_HEADER, over TLS to our own API; the server must read
 *    it and never log it. If the server colleague picks a different
 *    transport, change that one constant.
 */

/** The backup password's ride to the import route. See the note above. */
export const BACKUP_PASSWORD_HEADER = "x-rakazo-backup-password";

const EXPORT_CHUNK_BYTES = 1024 * 1024;

export type ExportDownloadResult = {
  fileUri: string;
  size: number;
  sha256: string;
};

function apiUrl(apiBase: string, path: string): string {
  return `${apiBase.replace(/\/+$/, "")}${path}`;
}

function sameExportEndpoint(apiBase: string, responseUrl: string | undefined): boolean {
  if (!responseUrl) return true;
  try {
    const expected = new URL(apiUrl(apiBase, "/api/account/export"));
    const answered = new URL(responseUrl);
    return (
      answered.origin === expected.origin &&
      answered.pathname.replace(/\/$/, "") === expected.pathname
    );
  } catch {
    return false;
  }
}

/**
 * POSTs the account export (one-time token + backup password in the JSON
 * body, never in a URL) and streams the zip straight to a cache file.
 * The token is single-use: a failure here spends it, so callers must fetch
 * a fresh token before retrying — never reuse one.
 */
export async function downloadAccountExport(input: {
  apiBase: string;
  headers: Record<string, string>;
  accountToken: string;
  backupPassword: string;
  onProgress?: (written: number, total: number) => void;
}): Promise<ExportDownloadResult> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.cache, "webdav-backup");
  if (!directory.exists) directory.create();
  const file = new File(directory, "rakazo-backup.zip");
  if (file.exists) file.delete();
  let response: Response;
  try {
    response = await fetch(apiUrl(input.apiBase, "/api/account/export"), {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: { ...input.headers, "content-type": "application/json" },
      body: JSON.stringify({
        accountToken: input.accountToken,
        backupPassword: input.backupPassword,
      }),
    });
  } catch {
    throw new WebdavBackupError("export-failed");
  }
  if (!response.ok) {
    throw new WebdavBackupError(
      response.status === 401 || response.status === 410 ? "export-expired" : "export-failed",
    );
  }
  if (response.redirected || !sameExportEndpoint(input.apiBase, response.url || undefined)) {
    throw new WebdavBackupError("export-failed");
  }
  const total = Number(response.headers.get("content-length") ?? 0) || -1;
  const writer = file.writableStream().getWriter();
  const hasher = createSha256();
  let size = 0;
  const fail = (code: WebdavBackupErrorCode): WebdavBackupError => {
    try {
      if (file.exists) file.delete();
    } catch {
      // A partial file is cleaned up best-effort; the error still reports.
    }
    return new WebdavBackupError(code);
  };
  try {
    const body = response.body as ReadableStream<Uint8Array> | null;
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        await writer.write(value);
        hasher.update(value);
        size += value.length;
        input.onProgress?.(size, total);
      }
    } else {
      // React Native's fetch buffers the body: slice the native blob into
      // bounded chunks instead of pulling the whole zip into JS memory.
      const blob = await response.blob();
      const blobSize = blob.size;
      for (let offset = 0; offset < blobSize; offset += EXPORT_CHUNK_BYTES) {
        const chunk = new Uint8Array(
          await blob.slice(offset, Math.min(blobSize, offset + EXPORT_CHUNK_BYTES)).arrayBuffer(),
        );
        await writer.write(chunk);
        hasher.update(chunk);
        size += chunk.length;
        input.onProgress?.(size, blobSize);
      }
    }
    await writer.close();
  } catch (error) {
    try {
      await writer.abort();
    } catch {
      // The writer is already gone; the partial file is what matters.
    }
    if (error instanceof WebdavBackupError) throw error;
    throw fail("export-failed");
  }
  return { fileUri: file.uri, size, sha256: hasher.digest() };
}

/** Puts a local file on the WebDAV server with a native UploadTask (PUT). */
export async function uploadFileToWebdav(input: {
  fileUri: string;
  url: string;
  username: string;
  password: string;
  contentType: string;
  onProgress?: (sent: number, total: number) => void;
}): Promise<void> {
  const { File, UploadType } = await import("expo-file-system");
  const file = new File(input.fileUri);
  if (!file.exists) throw new WebdavBackupError("not-found");
  const task = file.createUploadTask(input.url, {
    httpMethod: "PUT",
    uploadType: UploadType.BINARY_CONTENT,
    headers: {
      Authorization: basicAuthHeader(input.username, input.password),
      "content-type": input.contentType,
    },
    ...(input.onProgress
      ? {
          onProgress: (progress: { bytesSent: number; totalBytes: number }) => {
            input.onProgress?.(progress.bytesSent, progress.totalBytes);
          },
        }
      : null),
  });
  let result: { status: number };
  try {
    result = await task.uploadAsync();
  } catch {
    throw new WebdavBackupError("unreachable");
  } finally {
    task.release();
  }
  if (result.status === 401 || result.status === 403) throw new WebdavBackupError("auth");
  if (result.status < 200 || result.status >= 300) throw new WebdavBackupError("server-error");
}

/** Gets a WebDAV file with a native DownloadTask, straight to a local file. */
export async function downloadFileFromWebdav(input: {
  url: string;
  username: string;
  password: string;
  destinationFileUri: string;
}): Promise<string> {
  const { File } = await import("expo-file-system");
  const destination = new File(input.destinationFileUri);
  if (destination.exists) destination.delete();
  const task = File.createDownloadTask(input.url, destination, {
    headers: { Authorization: basicAuthHeader(input.username, input.password) },
  });
  let downloaded: { uri: string } | null;
  try {
    downloaded = await task.downloadAsync();
  } catch {
    throw new WebdavBackupError("unreachable");
  } finally {
    task.release();
  }
  if (!downloaded) throw new WebdavBackupError("cancelled");
  return downloaded.uri;
}

/**
 * POSTs a downloaded zip to the account import route as `application/zip`.
 * Restore imports as a new copy and never overwrites; the server reports a
 * wrong backup password through the import result, not through this call.
 * The backup password is required: a restore without one would hand the
 * whole backup to whoever holds the phone, so callers must verify it first.
 */
export async function importAccountZip(input: {
  apiBase: string;
  headers: Record<string, string>;
  fileUri: string;
  backupPassword: string;
}): Promise<{ status: number; body: unknown }> {
  const { File, UploadType } = await import("expo-file-system");
  const file = new File(input.fileUri);
  if (!file.exists) throw new WebdavBackupError("not-found");
  const task = file.createUploadTask(apiUrl(input.apiBase, "/api/account/import"), {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    headers: {
      ...input.headers,
      "content-type": "application/zip",
      [BACKUP_PASSWORD_HEADER]: input.backupPassword,
    },
  });
  let result: { status: number; body: string };
  try {
    result = await task.uploadAsync();
  } catch {
    throw new WebdavBackupError("unreachable");
  } finally {
    task.release();
  }
  if (result.status === 401 || result.status === 403) throw new WebdavBackupError("auth");
  if (result.status < 200 || result.status >= 300) throw new WebdavBackupError("import-failed");
  let body: unknown = null;
  try {
    body = result.body ? JSON.parse(result.body) : null;
  } catch {
    body = null;
  }
  return { status: result.status, body };
}
