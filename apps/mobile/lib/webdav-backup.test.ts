import { describe, expect, it, vi } from "vitest";
import type { WebdavFetch, WebdavResponse } from "./webdav-backup";
import {
  basicAuthHeader,
  buildBackupManifest,
  buildBackupSettingsFile,
  decideSync,
  ensureWebdavDirectory,
  getWebdavTextFile,
  isBackupPasswordBreached,
  listWebdavDirectory,
  normalizeWebdavServerUrl,
  parseBackupManifest,
  parseBackupSettingsFile,
  parsePropfindHrefs,
  putWebdavTextFile,
  sanitizeBackupDirectory,
  testWebdavConnection,
  validateBackupPassword,
  WebdavBackupError,
  webdavUrl,
} from "./webdav-backup";

const account = {
  serverUrl: "https://dav.example.com",
  username: "alice",
  password: "s3cret-pass",
  directory: "rakazo-backup",
};

function response(status: number, body = ""): WebdavResponse {
  return { status, text: async () => body };
}

function fetchStub(
  handler: (url: string, init: Parameters<WebdavFetch>[1]) => WebdavResponse,
): WebdavFetch {
  const stub = vi.fn(async (url: string, init: Parameters<WebdavFetch>[1]) => handler(url, init));
  return stub as unknown as WebdavFetch;
}

describe("normalizeWebdavServerUrl", () => {
  it("accepts https and strips a trailing slash", () => {
    expect(normalizeWebdavServerUrl("https://dav.example.com/dav/")).toEqual({
      ok: true,
      serverUrl: "https://dav.example.com/dav",
    });
  });

  it("refuses http", () => {
    expect(normalizeWebdavServerUrl("http://dav.example.com")).toEqual({
      ok: false,
      error: "https-required",
    });
  });

  it("refuses credentials in the URL", () => {
    expect(normalizeWebdavServerUrl("https://alice:s3cret@dav.example.com")).toEqual({
      ok: false,
      error: "credentials-in-url",
    });
  });

  it("refuses garbage", () => {
    expect(normalizeWebdavServerUrl("not a url")).toEqual({
      ok: false,
      error: "invalid-url",
    });
  });
});

describe("sanitizeBackupDirectory", () => {
  it("defaults an empty directory", () => {
    expect(sanitizeBackupDirectory("")).toEqual({ ok: true, segments: ["rakazo-backup"] });
  });

  it("keeps nested segments", () => {
    expect(sanitizeBackupDirectory("backups/rakazo")).toEqual({
      ok: true,
      segments: ["backups", "rakazo"],
    });
  });

  it("refuses .., a leading slash, backslashes, and empty segments", () => {
    for (const bad of ["../etc", "/rakazo-backup", "a\\b", "a//b", "a/", ".", "a/./b"]) {
      expect(sanitizeBackupDirectory(bad)).toEqual({ ok: false, error: "invalid-directory" });
    }
  });
});

describe("webdavUrl and the auth header", () => {
  it("percent-encodes segments and never carries credentials", () => {
    const url = webdavUrl("https://dav.example.com", ["my backup"], "rakazo-backup.zip");
    expect(url).toBe("https://dav.example.com/my%20backup/rakazo-backup.zip");
    expect(url).not.toContain("alice");
    expect(url).not.toContain("s3cret");
  });

  it("sends the password only in the Authorization header", () => {
    const header = basicAuthHeader("alice", "s3cret-pass");
    expect(header).toBe(`Basic ${Buffer.from("alice:s3cret-pass", "utf8").toString("base64")}`);
    expect(header).not.toContain("s3cret-pass");
  });
});

describe("parsePropfindHrefs", () => {
  it("pulls d:href values out of a multistatus body", () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/rakazo-backup/</d:href></d:response>
      <d:response><d:href>/rakazo-backup/rakazo-backup.zip</d:href></d:response>
      <d:response><d:href>/rakazo-backup/my%20file.json</d:href></d:response>
    </d:multistatus>`;
    expect(parsePropfindHrefs(xml)).toEqual([
      "/rakazo-backup/",
      "/rakazo-backup/rakazo-backup.zip",
      "/rakazo-backup/my file.json",
    ]);
  });
});

describe("testWebdavConnection", () => {
  it("maps 207/401/404 to ok/auth-error/missing-directory", async () => {
    for (const [status, expected] of [
      [207, "ok"],
      [401, "auth-error"],
      [403, "auth-error"],
      [404, "missing-directory"],
      [500, "server-error"],
    ] as const) {
      const fetchImpl = fetchStub(() => response(status));
      await expect(testWebdavConnection(account, fetchImpl)).resolves.toEqual({
        status: expected,
      });
    }
  });

  it("reports unreachable when fetch throws", async () => {
    const fetchImpl = fetchStub(() => {
      throw new Error("network down");
    });
    await expect(testWebdavConnection(account, fetchImpl)).resolves.toEqual({
      status: "unreachable",
    });
  });

  it("sends Depth 0 and a Basic header, never the password in the URL", async () => {
    const fetchImpl = fetchStub(() => response(207));
    await testWebdavConnection(account, fetchImpl);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(url).toBe("https://dav.example.com/rakazo-backup");
    expect((init as { headers: Record<string, string> }).headers.Depth).toBe("0");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toMatch(/^Basic /);
    expect(String(url)).not.toContain("s3cret");
  });
});

describe("ensureWebdavDirectory", () => {
  it("does nothing when the directory exists", async () => {
    const fetchImpl = fetchStub(() => response(207));
    await expect(ensureWebdavDirectory(account, fetchImpl)).resolves.toBeUndefined();
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1);
  });

  it("creates the directory on a 404 and treats 405 as already there", async () => {
    for (const mkcolStatus of [201, 405]) {
      const calls: string[] = [];
      const fetchImpl = fetchStub((url, init) => {
        calls.push(`${init.method} ${url}`);
        return response(init.method === "PROPFIND" ? 404 : mkcolStatus);
      });
      await expect(ensureWebdavDirectory(account, fetchImpl)).resolves.toBeUndefined();
      expect(calls).toEqual([
        "PROPFIND https://dav.example.com/rakazo-backup",
        "MKCOL https://dav.example.com/rakazo-backup",
      ]);
    }
  });

  it("stops on a missing parent and on bad credentials", async () => {
    const parentMissing = fetchStub((_, init) => response(init.method === "PROPFIND" ? 404 : 409));
    await expect(ensureWebdavDirectory(account, parentMissing)).rejects.toMatchObject({
      code: "parent-missing",
    });
    const badAuth = fetchStub(() => response(401));
    await expect(ensureWebdavDirectory(account, badAuth)).rejects.toMatchObject({
      code: "auth",
    });
  });
});

describe("listWebdavDirectory", () => {
  it("lists direct children only", async () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/rakazo-backup/</d:href></d:response>
      <d:response><d:href>/rakazo-backup/rakazo-backup.zip</d:href></d:response>
      <d:response><d:href>/rakazo-backup/rakazo-backup.json</d:href></d:response>
      <d:response><d:href>/rakazo-backup/nested/file.txt</d:href></d:response>
    </d:multistatus>`;
    const fetchImpl = fetchStub(() => response(207, xml));
    await expect(listWebdavDirectory(account, fetchImpl)).resolves.toEqual([
      "rakazo-backup.zip",
      "rakazo-backup.json",
    ]);
  });
});

describe("put/get text files", () => {
  it("PUTs with the auth header and reads a 404 as null", async () => {
    const seen: { method: string; url: string }[] = [];
    const fetchImpl = fetchStub((url, init) => {
      seen.push({ method: init.method, url });
      return response(init.method === "PUT" ? 201 : 404);
    });
    await putWebdavTextFile(account, "rakazo-backup.json", "{}", "application/json", fetchImpl);
    await expect(getWebdavTextFile(account, "rakazo-backup.json", fetchImpl)).resolves.toBeNull();
    expect(seen).toEqual([
      { method: "PUT", url: "https://dav.example.com/rakazo-backup/rakazo-backup.json" },
      { method: "GET", url: "https://dav.example.com/rakazo-backup/rakazo-backup.json" },
    ]);
  });

  it("throws a fixed-code error, never the server body", async () => {
    const fetchImpl = fetchStub(() => response(500, "password=s3cret-pass"));
    await expect(
      putWebdavTextFile(account, "x.json", "{}", "application/json", fetchImpl),
    ).rejects.toBeInstanceOf(WebdavBackupError);
    await expect(
      putWebdavTextFile(account, "x.json", "{}", "application/json", fetchImpl),
    ).rejects.toMatchObject({ code: "server-error" });
  });
});

describe("backup manifest", () => {
  it("round-trips and rejects a bad version or sha", () => {
    const manifest = buildBackupManifest({
      size: 12,
      sha256: "a".repeat(64),
      exportedAt: new Date("2026-11-10T00:00:00.000Z"),
    });
    expect(parseBackupManifest(manifest)).toEqual(manifest);
    expect(parseBackupManifest({ ...manifest, version: 2 })).toBeNull();
    expect(parseBackupManifest({ ...manifest, sha256: "xyz" })).toBeNull();
    expect(parseBackupManifest({ ...manifest, size: -1 })).toBeNull();
    expect(parseBackupManifest(null)).toBeNull();
  });
});

describe("decideSync", () => {
  const none = { exists: false, updatedAt: null, size: null, sha256: null };
  const local = {
    exists: true,
    updatedAt: "2026-11-10T10:00:00.000Z",
    size: 10,
    sha256: "a".repeat(64),
  };
  const remote = {
    exists: true,
    updatedAt: "2026-11-10T10:00:00.000Z",
    size: 10,
    sha256: "a".repeat(64),
  };

  it("uploads when only local exists, downloads when only remote exists", () => {
    expect(decideSync(local, none, null)).toBe("upload");
    expect(decideSync(none, remote, null)).toBe("download");
    expect(decideSync(none, none, null)).toBe("nothing");
  });

  it("is in sync on a matching sha", () => {
    expect(decideSync(local, remote, "2026-11-10T10:00:00.000Z")).toBe("in-sync");
  });

  it("follows the one side that moved since the last sync", () => {
    const last = "2026-11-10T09:00:00.000Z";
    expect(
      decideSync(
        { ...local, updatedAt: "2026-11-10T10:00:00.000Z", sha256: "b".repeat(64) },
        { ...remote, updatedAt: "2026-11-10T09:00:00.000Z" },
        last,
      ),
    ).toBe("upload");
    expect(
      decideSync(
        { ...local, updatedAt: "2026-11-10T09:00:00.000Z" },
        { ...remote, updatedAt: "2026-11-10T10:00:00.000Z", sha256: "c".repeat(64) },
        last,
      ),
    ).toBe("download");
  });

  it("never silently overwrites: both sides changed is a conflict", () => {
    const last = "2026-11-10T09:00:00.000Z";
    expect(
      decideSync(
        { ...local, updatedAt: "2026-11-10T10:00:00.000Z", sha256: "b".repeat(64) },
        { ...remote, updatedAt: "2026-11-10T11:00:00.000Z", sha256: "c".repeat(64) },
        last,
      ),
    ).toBe("conflict");
    // No last sync at all and two different backups: also a conflict.
    expect(
      decideSync({ ...local, sha256: "b".repeat(64) }, { ...remote, sha256: "c".repeat(64) }, null),
    ).toBe("conflict");
  });
});

describe("settings file", () => {
  it("carries only appearance settings, never a password", () => {
    const file = buildBackupSettingsFile({
      userId: "user-1",
      heroBackground: { thread1: { kind: "url", uri: "https://img.example/x.png", opacity: 40 } },
      chatBackgrounds: { thread1: { kind: "image", uri: "file:///doc/a.jpg", opacity: 50 } },
      expressionPack: "chief",
    });
    expect(file.settings.custom).toEqual({});
    expect(JSON.stringify(file)).not.toMatch(/password|secret|token|webdav/i);
    expect(parseBackupSettingsFile(file)).toEqual(file);
    expect(
      parseBackupSettingsFile({ ...file, settings: { ...file.settings, extra: 1 } }),
    ).toBeNull();
    expect(
      parseBackupSettingsFile({
        ...file,
        settings: { ...file.settings, expressionPack: "fancy" },
      }),
    ).toBeNull();
  });

  it("carries a provided interface settings snapshot as custom", () => {
    const custom = {
      heroBackgroundHeights: { thread1: 70 },
      chipsRowWidthPct: 80,
      font: { family: "system", title: { size: 19, color: null } },
    };
    const file = buildBackupSettingsFile({
      userId: "user-1",
      heroBackground: {},
      chatBackgrounds: {},
      expressionPack: "chief",
      custom,
    });
    expect(file.settings.custom).toEqual(custom);
    expect(parseBackupSettingsFile(file)).toEqual(file);
  });

  it("drops invalid background entries when building", () => {
    const file = buildBackupSettingsFile({
      userId: "user-1",
      heroBackground: {
        good: { kind: "url", uri: "https://img.example/x.png", opacity: 40 },
        // @ts-expect-error a bad entry from a corrupt store
        bad: { kind: "gif", uri: 42, opacity: "high" },
      },
      chatBackgrounds: {},
      expressionPack: "off",
    });
    expect(file.settings.heroBackground).toEqual({
      good: { kind: "url", uri: "https://img.example/x.png", opacity: 40 },
    });
  });
});

describe("validateBackupPassword", () => {
  it("needs 12 characters and refuses the account password", () => {
    expect(validateBackupPassword("short", "account-pass")).toBe("too-short");
    expect(validateBackupPassword("account-pass-long", "account-pass-long")).toBe(
      "same-as-account",
    );
    expect(validateBackupPassword("a-different-long-one", "account-pass")).toBeNull();
  });
});

describe("isBackupPasswordBreached", () => {
  it("sends only the five-character SHA-1 prefix and matches the suffix", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return {
        status: 200,
        text: async () =>
          "0018A45C4D1DEF81644B54AB7F969B88D65:2\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:12345\n",
      };
    });
    // "password" SHA-1 is 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8.
    await expect(isBackupPasswordBreached("password", fetchImpl)).resolves.toBe(true);
    expect(seen).toEqual(["https://api.pwnedpasswords.com/range/5BAA6"]);
    await expect(isBackupPasswordBreached("a-long-safe-password", fetchImpl)).resolves.toBe(false);
  });

  it("fails open when the check is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(isBackupPasswordBreached("password", fetchImpl)).resolves.toBe(false);
  });
});
