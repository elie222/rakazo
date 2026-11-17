// The SDKs are mocked here: an Azure identity token is only sent over https, so a local fake
// server cannot receive one. What this file holds to is the wiring — which credential the
// adapter builds for each `OBJECT_STORAGE_AUTH`, and the client options around it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  sharedKey: vi.fn(),
  clientSecret: vi.fn(),
  certificate: vi.fn(),
  federated: vi.fn(),
  managed: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@azure/storage-blob", () => {
  class BlobServiceClient {
    constructor(
      public readonly url: string,
      public readonly credential: unknown,
      public readonly options: unknown,
    ) {
      mocks.client(this.url, this.credential, this.options);
    }
    getContainerClient(container: string) {
      return {
        container,
        getBlockBlobClient: (key: string) => ({
          blob: key,
          upload: mocks.upload,
          stageBlock: mocks.upload,
          commitBlockList: mocks.upload,
        }),
      };
    }
  }
  class StorageSharedKeyCredential {
    constructor(
      public readonly account: string,
      public readonly accountKey: string,
    ) {
      mocks.sharedKey(account, accountKey);
    }
  }
  return { BlobServiceClient, StorageSharedKeyCredential };
});

vi.mock("@azure/identity", () => {
  class ClientSecretCredential {
    constructor(...args: unknown[]) {
      mocks.clientSecret(...args);
    }
  }
  class ClientCertificateCredential {
    constructor(...args: unknown[]) {
      mocks.certificate(...args);
    }
  }
  class WorkloadIdentityCredential {
    constructor(...args: unknown[]) {
      mocks.federated(...args);
    }
  }
  class ManagedIdentityCredential {
    constructor(...args: unknown[]) {
      mocks.managed(...args);
    }
  }
  return {
    ClientSecretCredential,
    ClientCertificateCredential,
    WorkloadIdentityCredential,
    ManagedIdentityCredential,
  };
});

import type { AzureBlobAuth } from "./azure-blob-object-storage.js";
import { AzureBlobObjectStorage } from "./azure-blob-object-storage.js";

function storage(auth: AzureBlobAuth, endpoint?: string) {
  return new AzureBlobObjectStorage({
    container: "container",
    account: "account",
    auth,
    ...(endpoint ? { endpoint } : {}),
    prefix: "",
  });
}

async function* bytes() {
  yield Buffer.from("x");
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.upload.mockResolvedValue({});
});

describe("Azure Blob credential wiring", () => {
  it("passes the account's shared key with the account name", async () => {
    await storage({ kind: "account-key", accountKey: "key" }).put("k", bytes());

    expect(mocks.sharedKey).toHaveBeenCalledWith("account", "key");
    expect(mocks.clientSecret).not.toHaveBeenCalled();
    // Nothing but the SDK is loaded for a deployment that uses a key.
    expect(mocks.client).toHaveBeenCalledWith(
      "https://account.blob.core.windows.net",
      expect.any(Object),
      expect.objectContaining({ retryOptions: { tryTimeoutInMs: 120_000 } }),
    );
  });

  it("builds a service principal's secret credential", async () => {
    await storage({
      kind: "client-secret",
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
    }).put("k", bytes());

    expect(mocks.clientSecret).toHaveBeenCalledWith("tenant", "client", "secret");
    expect(mocks.sharedKey).not.toHaveBeenCalled();
  });

  it("builds a certificate credential from the PEM", async () => {
    await storage({
      kind: "client-certificate",
      tenantId: "tenant",
      clientId: "client",
      certificate: "-----BEGIN CERTIFICATE-----",
    }).put("k", bytes());

    expect(mocks.certificate).toHaveBeenCalledWith("tenant", "client", {
      certificate: "-----BEGIN CERTIFICATE-----",
    });
  });

  it("builds a workload identity credential from the projected token file", async () => {
    await storage({
      kind: "federated-identity",
      tenantId: "tenant",
      clientId: "client",
      tokenFilePath: "/var/run/secrets/azure/token",
    }).put("k", bytes());

    expect(mocks.federated).toHaveBeenCalledWith({
      tenantId: "tenant",
      clientId: "client",
      tokenFilePath: "/var/run/secrets/azure/token",
    });
  });

  it.each([
    ["the host's identity", undefined, []],
    ["a named user-assigned identity", "user-assigned", [{ clientId: "user-assigned" }]],
  ] as const)("builds %s", async (_label, clientId, args) => {
    await storage({ kind: "managed-identity", clientId }).put("k", bytes());

    expect(mocks.managed).toHaveBeenCalledWith(...args);
  });
});
