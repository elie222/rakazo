import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "./backup-crypto";

const fsMocks = vi.hoisted(() => ({
  files: new Map<string, { exists: boolean; chunks: Uint8Array[] }>(),
  uploadCalls: [] as {
    fileUri: string;
    url: string;
    options: Record<string, unknown>;
  }[],
  downloadCalls: [] as {
    url: string;
    destination: string;
    options: Record<string, unknown>;
  }[],
  uploadStatus: 201,
  uploadBody: "{}",
  downloadResult: { uri: "file:///cache/webdav-backup/rakazo-backup.zip" } as {
    uri: string;
  } | null,
}));

class MockFile {
  uri: string;
  constructor(...uris: (string | { uri: string })[]) {
    this.uri = uris.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
  }
  get exists() {
    return fsMocks.files.get(this.uri)?.exists ?? false;
  }
  delete() {
    fsMocks.files.delete(this.uri);
  }
  writableStream() {
    const uri = this.uri;
    return {
      getWriter: () => ({
        write: async (chunk: Uint8Array) => {
          const entry = fsMocks.files.get(uri) ?? { exists: true, chunks: [] };
          entry.exists = true;
          entry.chunks.push(chunk);
          fsMocks.files.set(uri, entry);
        },
        close: async () => undefined,
        abort: async () => undefined,
      }),
    };
  }
  createUploadTask(url: string, options: Record<string, unknown>) {
    fsMocks.uploadCalls.push({ fileUri: this.uri, url, options });
    return {
      uploadAsync: async () => ({
        status: fsMocks.uploadStatus,
        body: fsMocks.uploadBody,
        headers: {},
      }),
      release: () => undefined,
    };
  }
  static createDownloadTask(url: string, destination: MockFile, options: Record<string, unknown>) {
    fsMocks.downloadCalls.push({ url, destination: destination.uri, options });
    return {
      downloadAsync: async () => fsMocks.downloadResult,
      release: () => undefined,
    };
  }
}

class MockDirectory {
  uri: string;
  constructor(parent: string | MockDirectory, name?: string) {
    const base = typeof parent === "string" ? parent : parent.uri;
    this.uri = name === undefined ? base : `${base}/${name}`;
  }
  get exists() {
    return true;
  }
  create() {
    // The cache directory always exists in the mock.
  }
}

vi.mock("expo-file-system", () => ({
  File: MockFile,
  Directory: MockDirectory,
  Paths: { document: "file:///doc", cache: "file:///cache" },
  UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));

import {
  downloadAccountExport,
  downloadFileFromWebdav,
  importAccountZip,
  uploadFileToWebdav,
} from "./webdav-backup-transfer";

const zipBytes = new TextEncoder().encode("PK-fake-zip-bytes");
const zipSha = sha256Hex(zipBytes);

function fetchResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: "https://api.example.com/api/account/export",
    headers: { get: () => String(zipBytes.length) },
    body: {
      getReader: () => {
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: zipBytes };
          },
        };
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  fsMocks.files.clear();
  fsMocks.uploadCalls.length = 0;
  fsMocks.downloadCalls.length = 0;
  fsMocks.uploadStatus = 201;
  fsMocks.uploadBody = "{}";
  fsMocks.downloadResult = { uri: "file:///cache/webdav-backup/rakazo-backup.zip" };
  vi.unstubAllGlobals();
});

describe("downloadAccountExport", () => {
  it("POSTs token and password in the body and streams the zip to disk", async () => {
    const seen: { url: string; init: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: Record<string, unknown>) => {
        seen.push({ url, init });
        return fetchResponse();
      }),
    );
    const result = await downloadAccountExport({
      apiBase: "https://api.example.com",
      headers: { authorization: "Bearer session-token" },
      accountToken: "one-time-token",
      backupPassword: "backup-password-long",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.example.com/api/account/export");
    expect(seen[0]!.url).not.toContain("one-time-token");
    expect(seen[0]!.url).not.toContain("backup-password-long");
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body).toEqual({
      accountToken: "one-time-token",
      backupPassword: "backup-password-long",
    });
    expect(result.size).toBe(zipBytes.length);
    expect(result.sha256).toBe(zipSha);
    expect(result.fileUri).toBe("file:///cache/webdav-backup/rakazo-backup.zip");
    const written = fsMocks.files.get(result.fileUri)?.chunks ?? [];
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual(zipBytes);
  });

  it("falls back to bounded blob slices when the body does not stream", async () => {
    const blob = {
      size: zipBytes.length,
      slice: (start: number, end: number) => ({
        arrayBuffer: async () => zipBytes.slice(start, end).buffer as ArrayBuffer,
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fetchResponse({ body: null, blob: async () => blob })),
    );
    const result = await downloadAccountExport({
      apiBase: "https://api.example.com",
      headers: {},
      accountToken: "token",
      backupPassword: "backup-password-long",
    });
    expect(result.sha256).toBe(zipSha);
    expect(result.size).toBe(zipBytes.length);
  });

  it("maps a 410 to export-expired so the caller fetches a fresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fetchResponse({ ok: false, status: 410 })),
    );
    await expect(
      downloadAccountExport({
        apiBase: "https://api.example.com",
        headers: {},
        accountToken: "spent-token",
        backupPassword: "backup-password-long",
      }),
    ).rejects.toMatchObject({ code: "export-expired" });
  });
});

describe("uploadFileToWebdav", () => {
  it("PUTs the file with a Basic header and no credentials in the URL", async () => {
    fsMocks.files.set("file:///cache/webdav-backup/rakazo-backup.zip", {
      exists: true,
      chunks: [],
    });
    await uploadFileToWebdav({
      fileUri: "file:///cache/webdav-backup/rakazo-backup.zip",
      url: "https://dav.example.com/rakazo-backup/rakazo-backup.zip",
      username: "alice",
      password: "s3cret-pass",
      contentType: "application/zip",
    });
    expect(fsMocks.uploadCalls).toHaveLength(1);
    const call = fsMocks.uploadCalls[0]!;
    expect(call.url).toBe("https://dav.example.com/rakazo-backup/rakazo-backup.zip");
    expect(call.url).not.toContain("s3cret");
    expect(call.options.httpMethod).toBe("PUT");
    expect(call.options.uploadType).toBe(0);
    const headers = call.options.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("alice:s3cret-pass", "utf8").toString("base64")}`,
    );
    expect(headers["content-type"]).toBe("application/zip");
  });

  it("maps a 401 to an auth error", async () => {
    fsMocks.files.set("file:///cache/x.zip", { exists: true, chunks: [] });
    fsMocks.uploadStatus = 401;
    await expect(
      uploadFileToWebdav({
        fileUri: "file:///cache/x.zip",
        url: "https://dav.example.com/rakazo-backup/rakazo-backup.zip",
        username: "alice",
        password: "wrong",
        contentType: "application/zip",
      }),
    ).rejects.toMatchObject({ code: "auth" });
  });
});

describe("downloadFileFromWebdav", () => {
  it("GETs with a DownloadTask and the auth header", async () => {
    const uri = await downloadFileFromWebdav({
      url: "https://dav.example.com/rakazo-backup/rakazo-backup.zip",
      username: "alice",
      password: "s3cret-pass",
      destinationFileUri: "file:///cache/webdav-backup/rakazo-backup.zip",
    });
    expect(uri).toBe("file:///cache/webdav-backup/rakazo-backup.zip");
    expect(fsMocks.downloadCalls).toHaveLength(1);
    const headers = fsMocks.downloadCalls[0]!.options.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(fsMocks.downloadCalls[0]!.url).not.toContain("s3cret");
  });
});

describe("importAccountZip", () => {
  it("POSTs the zip as application/zip with the backup password header", async () => {
    fsMocks.files.set("file:///cache/webdav-backup/rakazo-backup.zip", {
      exists: true,
      chunks: [],
    });
    const result = await importAccountZip({
      apiBase: "https://api.example.com",
      headers: { authorization: "Bearer session-token" },
      fileUri: "file:///cache/webdav-backup/rakazo-backup.zip",
      backupPassword: "backup-password-long",
    });
    expect(result.status).toBe(201);
    expect(fsMocks.uploadCalls).toHaveLength(1);
    const call = fsMocks.uploadCalls[0]!;
    expect(call.url).toBe("https://api.example.com/api/account/import");
    expect(call.options.httpMethod).toBe("POST");
    const headers = call.options.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/zip");
    expect(headers["x-rakazo-backup-password"]).toBe("backup-password-long");
    expect(call.url).not.toContain("backup-password-long");
  });

  it("omits the password header when no restore password was entered", async () => {
    fsMocks.files.set("file:///cache/webdav-backup/rakazo-backup.zip", {
      exists: true,
      chunks: [],
    });
    await importAccountZip({
      apiBase: "https://api.example.com",
      headers: {},
      fileUri: "file:///cache/webdav-backup/rakazo-backup.zip",
    });
    const headers = fsMocks.uploadCalls[0]!.options.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("x-rakazo-backup-password");
  });
});
