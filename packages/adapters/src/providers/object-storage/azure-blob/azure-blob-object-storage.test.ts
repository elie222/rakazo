import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { objectStorageConformance } from "../../../storage/object-storage.test-support.js";
import { AzureBlobObjectStorage, azureBlobConfigFromEnv } from "./azure-blob-object-storage.js";

/**
 * Just enough of the Blob REST API, addressed as `<host>/<account>/<container>/<blob>`, to
 * exercise the adapter offline: single-request and block uploads, reads, paged listings and
 * deletes. Shared-key signatures are not checked; a bearer token must be exactly the test token.
 */
function fakeBlobService(tls?: { key: string; cert: string }) {
  const blobs = new Map<string, { body: Buffer; lastModified: Date }>();
  const staged = new Map<string, Buffer>();
  const requests: string[] = [];
  const xml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://fake");
    const [, account, container, ...rest] = url.pathname.split("/");
    const name = decodeURIComponent(rest.join("/"));
    const query = url.searchParams;
    const send = (status: number, payload: string | Buffer = "", headers = {}) => {
      res.writeHead(status, {
        "x-ms-request-id": "fake",
        ...(typeof payload === "string" && payload && { "Content-Type": "application/xml" }),
        ...headers,
      });
      res.end(payload);
    };
    const comp = query.get("comp");
    const stalled = name.endsWith("/stalled") || name === "stalled";
    requests.push(`${req.method} ${name ? "blob" : "container"}${comp ? `?${comp}` : ""}`);
    // Shared-key signatures are not checked. The TLS fake serves the Entra path, where every
    // request must carry the credential's exact token — wrong or missing are both refused.
    const authorization = req.headers.authorization;
    if ((req.socket as TLSSocket).encrypted && authorization !== `Bearer ${TEST_TOKEN}`)
      return send(401, "<Error><Code>AuthenticationFailed</Code></Error>", {
        "x-ms-error-code": "AuthenticationFailed",
      });
    if (account !== "devstoreaccount1" || container !== "test-container")
      return send(404, "<Error><Code>ContainerNotFound</Code></Error>", {
        "x-ms-error-code": "ContainerNotFound",
      });
    if (req.method === "PUT" && comp === "block") {
      staged.set(`${name}/${query.get("blockid")}`, body);
      return send(201);
    }
    if (req.method === "PUT" && comp === "blocklist") {
      const ids = [...body.toString().matchAll(/<Latest>([^<]*)<\/Latest>/g)].map((m) => m[1]!);
      blobs.set(name, {
        body: Buffer.concat(ids.map((id) => staged.get(`${name}/${id}`)!)),
        lastModified: new Date(),
      });
      for (const id of ids) staged.delete(`${name}/${id}`);
      return send(201);
    }
    if (req.method === "PUT") {
      blobs.set(name, { body, lastModified: new Date() });
      return send(201);
    }
    if (req.method === "DELETE") {
      if (!blobs.delete(name))
        return send(404, "<Error><Code>BlobNotFound</Code></Error>", {
          "x-ms-error-code": "BlobNotFound",
        });
      return send(202);
    }
    if (req.method === "GET" && comp === "list") {
      // Two blobs a page, so the adapter has to follow continuation markers.
      const prefix = query.get("prefix") ?? "";
      const all = [...blobs.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = Number(query.get("marker") ?? 0);
      const page = all.slice(start, start + 2);
      const next = start + 2 < all.length ? String(start + 2) : "";
      return send(
        200,
        `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ContainerName="http://fake/${account}/${container}"><Prefix>${xml(prefix)}</Prefix><Blobs>${page
          .map(
            (key) =>
              `<Blob><Name>${xml(key)}</Name><Properties><Last-Modified>${blobs.get(key)!.lastModified.toUTCString()}</Last-Modified><Content-Length>${blobs.get(key)!.body.length}</Content-Length><BlobType>BlockBlob</BlobType></Properties></Blob>`,
          )
          .join("")}</Blobs><NextMarker>${next}</NextMarker></EnumerationResults>`,
        { "Content-Type": "application/xml" },
      );
    }
    if (req.method === "GET" && stalled) {
      // Headers and the first bytes, then silence.
      res.writeHead(200, {
        "Content-Length": 1_000_000,
        "x-ms-blob-type": "BlockBlob",
        ETag: '"blob"',
        "Last-Modified": new Date().toUTCString(),
      });
      res.write(Buffer.alloc(10));
      return;
    }
    if (req.method === "GET") {
      const blob = blobs.get(name);
      if (!blob)
        return send(404, "<Error><Code>BlobNotFound</Code></Error>", {
          "x-ms-error-code": "BlobNotFound",
        });
      return send(200, blob.body, {
        "Content-Length": blob.body.length,
        "Content-Type": "application/octet-stream",
        "Last-Modified": blob.lastModified.toUTCString(),
        ETag: '"blob"',
        "x-ms-blob-type": "BlockBlob",
      });
    }
    send(400, "<Error><Code>BadRequest</Code></Error>");
  };
  const server = tls ? createHttpsServer(tls, serve) : createHttpServer(serve);
  return { server, blobs, requests };
}

const fake = fakeBlobService();
let endpoint = "";

/**
 * The one bearer token the fake accepts: it proves the Entra path sends the credential's token,
 * and lets a wrong token be rejected, so a pass through this path is never vacuous.
 */
const TEST_TOKEN = "entra-test-token";

/** Offline stand-in for the identity SDK: a client-secret credential's token is its secret. */
vi.mock("@azure/identity", () => ({
  ClientSecretCredential: class {
    constructor(
      _tenant: string,
      _clientId: string,
      private readonly secret: string,
    ) {}
    async getToken() {
      return { token: this.secret, expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  },
}));

/**
 * Bearer tokens travel over TLS only (the SDK refuses plain http), so the Entra suite runs
 * against its own https fake, served with the throwaway fixture pair. Its self-signed
 * certificate names 127.0.0.1 and is trusted for this file alone, so TLS is still verified.
 */
const fixturePem = readFileSync(
  new URL("./azure-entra-test-certificate.pem", import.meta.url),
  "utf8",
);
const entraFake = fakeBlobService({ key: fixturePem, cert: fixturePem });
let entraEndpoint = "";

/** The default trust store, restored after the file's tests. */
const trusted = getCACertificates("default");

beforeAll(async () => {
  setDefaultCACertificates([...trusted, fixturePem]);
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/devstoreaccount1`;
  await new Promise<void>((resolve) => entraFake.server.listen(0, "127.0.0.1", resolve));
  entraEndpoint = `https://127.0.0.1:${(entraFake.server.address() as AddressInfo).port}/devstoreaccount1`;
});

afterAll(async () => {
  setDefaultCACertificates(trusted);
  await new Promise((resolve) => fake.server.close(resolve));
  await new Promise((resolve) => entraFake.server.close(resolve));
});

function storage(prefix = "") {
  return new AzureBlobObjectStorage({
    container: "test-container",
    account: "devstoreaccount1",
    accountKey: Buffer.from("fake-account-key").toString("base64"),
    endpoint,
    prefix,
  });
}

async function* bytes(...parts: Buffer[]) {
  yield* parts;
}

let run = 0;
describe("AzureBlobObjectStorage", () => {
  objectStorageConformance(async () => storage(`run-${++run}/`));

  it("keeps every object under the configured prefix", async () => {
    await storage("deployment-a/").put("homes/x/1", bytes(Buffer.from("x")));
    expect(fake.blobs.has("deployment-a/homes/x/1")).toBe(true);
    const listed: string[] = [];
    for await (const object of storage("deployment-b/").list("homes/")) listed.push(object.key);
    expect(listed).toEqual([]);
  });

  it("uploads a small home in one request and a large one in blocks", async () => {
    fake.requests.length = 0;
    await storage("requests/").put("small", bytes(Buffer.alloc(1024)));
    expect(fake.requests).toEqual(["PUT blob"]);

    fake.requests.length = 0;
    await storage("requests/").put(
      "large",
      (async function* () {
        for (let index = 0; index < 33; index += 1) yield Buffer.alloc(1024 * 1024, index);
      })(),
    );
    expect(fake.requests).toEqual([
      "PUT blob?block",
      "PUT blob?block",
      "PUT blob?block",
      "PUT blob?blocklist",
    ]);
  });

  it("keeps concurrent uploads to one key apart", async () => {
    const source = (byte: number) =>
      (async function* () {
        for (let index = 0; index < 33; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          yield Buffer.alloc(1024 * 1024, byte);
        }
      })();
    const shared = storage("concurrent/");
    await Promise.all([shared.put("k", source(1)), shared.put("k", source(2))]);
    const stored = fake.blobs.get("concurrent/k")!.body;
    expect(stored.length).toBe(33 * 1024 * 1024);
    expect(new Set(stored).size).toBe(1);
  });

  it("fails a read whose body stops after the first bytes", async () => {
    const quick = new AzureBlobObjectStorage(
      {
        container: "test-container",
        account: "devstoreaccount1",
        accountKey: Buffer.from("fake-account-key").toString("base64"),
        endpoint,
        prefix: "",
      },
      300,
    );
    await expect(
      (async () => {
        for await (const _chunk of quick.get("stalled")) {
          // drain
        }
      })(),
    ).rejects.toThrow();
  });

  it("commits nothing when the source fails", async () => {
    await expect(
      storage("abort/").put(
        "broken",
        (async function* () {
          yield Buffer.alloc(40 * 1024 * 1024);
          throw new Error("source failed");
        })(),
      ),
    ).rejects.toThrow("source failed");
    expect(fake.blobs.has("abort/broken")).toBe(false);
  });

  it("fails clearly when the container does not exist", async () => {
    const missing = new AzureBlobObjectStorage({
      container: "missing",
      account: "devstoreaccount1",
      accountKey: Buffer.from("fake-account-key").toString("base64"),
      endpoint,
      prefix: "",
    });
    await expect(missing.put("k", bytes(Buffer.from("x")))).rejects.toThrow();
  });
});

describe("AzureBlobObjectStorage with an Entra credential", () => {
  let entraRun = 0;

  function entraStorage(prefix: string, clientSecret = TEST_TOKEN) {
    return new AzureBlobObjectStorage({
      container: "test-container",
      account: "devstoreaccount1",
      endpoint: entraEndpoint,
      prefix,
      entra: { kind: "client-secret", tenant: "directory", clientId: "principal", clientSecret },
    });
  }

  objectStorageConformance(async () => entraStorage(`entra-${++entraRun}/`));

  it("rejects a request whose token is not the credential's", async () => {
    const wrong = entraStorage("wrong-token/", "not-the-token");
    await expect(wrong.put("k", bytes(Buffer.from("x")))).rejects.toThrow();
    expect(entraFake.blobs.has("wrong-token/k")).toBe(false);
  });

  it("needs an account key or an Entra kind", () => {
    expect(
      () =>
        new AzureBlobObjectStorage({
          container: "test-container",
          account: "devstoreaccount1",
          endpoint,
          prefix: "",
        }),
    ).toThrow(/account key or an Entra/);
  });
});

describe("azureBlobConfigFromEnv", () => {
  const base = {
    OBJECT_STORAGE_BUCKET: "homes",
    OBJECT_STORAGE_ACCESS_KEY_ID: "account",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "key",
  };

  it("is off without a container", () => {
    expect(azureBlobConfigFromEnv({})).toBeUndefined();
  });

  it("requires its own credentials", () => {
    expect(() => azureBlobConfigFromEnv({ OBJECT_STORAGE_BUCKET: "homes" })).toThrow(
      /OBJECT_STORAGE_ACCESS_KEY_ID/,
    );
  });

  it("reads the shared connection settings", () => {
    expect(
      azureBlobConfigFromEnv({
        ...base,
        OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:10000/account",
        OBJECT_STORAGE_PREFIX: "/rakazo/",
      }),
    ).toEqual({
      container: "homes",
      account: "account",
      accountKey: "key",
      endpoint: "http://127.0.0.1:10000/account",
      prefix: "rakazo/",
    });
  });

  it("reads an Entra kind instead of the account key", () => {
    expect(
      azureBlobConfigFromEnv({
        ...base,
        OBJECT_STORAGE_AUTH: "client-secret",
        OBJECT_STORAGE_TENANT: "directory",
        OBJECT_STORAGE_CLIENT_ID: "principal",
        OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
      }),
    ).toEqual({
      container: "homes",
      account: "account",
      entra: {
        kind: "client-secret",
        tenant: "directory",
        clientId: "principal",
        clientSecret: "secret",
      },
      prefix: "",
    });
  });

  it("still names the storage account under an Entra kind", () => {
    expect(() =>
      azureBlobConfigFromEnv({
        OBJECT_STORAGE_BUCKET: "homes",
        OBJECT_STORAGE_AUTH: "managed-identity",
      }),
    ).toThrow(/OBJECT_STORAGE_ACCESS_KEY_ID/);
  });

  it("refuses a plain-http endpoint under an Entra kind, at startup", () => {
    expect(() =>
      azureBlobConfigFromEnv({
        ...base,
        OBJECT_STORAGE_AUTH: "client-secret",
        OBJECT_STORAGE_TENANT: "directory",
        OBJECT_STORAGE_CLIENT_ID: "principal",
        OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
        OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:10000/devstoreaccount1",
      }),
    ).toThrow(/https OBJECT_STORAGE_ENDPOINT/);
  });
});
