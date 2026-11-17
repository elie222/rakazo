import { describe, expect, it } from "vitest";
import { objectStorageConformance } from "../../../object-storage.test-support.js";
import { AzureBlobObjectStorage } from "./azure-blob-object-storage.js";
import { entraCredential } from "./azure-entra-credential.js";

/**
 * Runs the new Entra authentication path against a real Azure Blob Storage account with a real
 * Entra token, and probes the client-secret kind against the real Entra token endpoint. Set
 * `REAL_AZURE_BLOB_ACCOUNT`, `REAL_AZURE_BLOB_CONTAINER`, `REAL_AZURE_BLOB_ENTRA_TOKEN` and
 * `REAL_AZURE_BLOB_TENANT` to enable; without them these tests skip, so CI and offline runs
 * never touch Azure. Not part of the repository's suites: a verification artifact for
 * plans/2026-11-17-0933-azure-blob-entra-auth.
 */
const account = process.env.REAL_AZURE_BLOB_ACCOUNT;
const container = process.env.REAL_AZURE_BLOB_CONTAINER;
const tenant = process.env.REAL_AZURE_BLOB_TENANT;
const token = process.env.REAL_AZURE_BLOB_ENTRA_TOKEN?.trim();
const enabled = !!(account && container && token);

describe.skipIf(!enabled)("azure-blob Entra path against real Azure", { timeout: 600_000 }, () => {
  let run = 0;

  function entraStorage(prefix: string) {
    return new AzureBlobObjectStorage({
      container: container!,
      account: account!,
      entra: {
        kind: "token",
        credential: {
          getToken: async () => ({ token: token!, expiresOnTimestamp: Date.now() + 3_600_000 }),
        },
      },
      prefix,
    });
  }

  objectStorageConformance(async () => {
    run += 1;
    return entraStorage(`entra-verify-${run}/`);
  });

  it("rejects a wrong Entra token", async () => {
    const storage = new AzureBlobObjectStorage({
      container: container!,
      account: account!,
      entra: {
        kind: "token",
        credential: {
          getToken: async () => ({ token: "not-a-token", expiresOnTimestamp: Date.now() + 1000 }),
        },
      },
      prefix: "entra-wrong-token/",
    });
    async function* body() {
      yield Buffer.from("x");
    }
    await expect(storage.put("k", body())).rejects.toThrow();
  });

  it("reaches the real Entra token endpoint for the client-secret kind", async () => {
    const credential = await entraCredential({
      kind: "client-secret",
      tenant: tenant!,
      clientId: "00000000-0000-0000-0000-000000000000",
      clientSecret: "definitely-not-registered",
    });
    // No app registration exists in this tenant, so the real endpoint must refuse the client.
    await expect(credential.getToken("https://storage.azure.com/.default")).rejects.toThrow(
      /AADSTS|unauthorized_client|not found|Invalid client|CredentialUnavailable|AuthenticationFailed/i,
    );
  });
});
