import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { entraAuthFromEnv, entraCredential } from "./azure-entra-credential.js";

describe("entraAuthFromEnv", () => {
  const principal = {
    OBJECT_STORAGE_TENANT: "directory",
    OBJECT_STORAGE_CLIENT_ID: "principal",
  };

  it("is off without OBJECT_STORAGE_AUTH, and for the account key", () => {
    expect(entraAuthFromEnv({})).toBeUndefined();
    expect(entraAuthFromEnv({ OBJECT_STORAGE_AUTH: "account-key" })).toBeUndefined();
  });

  it("reads a service principal with a client secret", () => {
    expect(
      entraAuthFromEnv({
        OBJECT_STORAGE_AUTH: "client-secret",
        ...principal,
        OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
      }),
    ).toEqual({
      kind: "client-secret",
      tenant: "directory",
      clientId: "principal",
      clientSecret: "secret",
    });
  });

  it("reads a service principal with a certificate", () => {
    expect(
      entraAuthFromEnv({
        OBJECT_STORAGE_AUTH: "client-certificate",
        ...principal,
        OBJECT_STORAGE_CERTIFICATE: "/certs/principal.pem",
      }),
    ).toEqual({
      kind: "client-certificate",
      tenant: "directory",
      clientId: "principal",
      certificate: "/certs/principal.pem",
    });
  });

  it("reads a federated workload identity", () => {
    expect(
      entraAuthFromEnv({
        OBJECT_STORAGE_AUTH: "federated-identity",
        ...principal,
        OBJECT_STORAGE_FEDERATED_TOKEN_FILE: "/var/run/secrets/tokens/oidc-token",
      }),
    ).toEqual({
      kind: "federated-identity",
      tenant: "directory",
      clientId: "principal",
      tokenFile: "/var/run/secrets/tokens/oidc-token",
    });
  });

  it("reads a managed identity, with and without a client id", () => {
    expect(entraAuthFromEnv({ OBJECT_STORAGE_AUTH: "managed-identity" })).toEqual({
      kind: "managed-identity",
    });
    expect(
      entraAuthFromEnv({
        OBJECT_STORAGE_AUTH: "managed-identity",
        OBJECT_STORAGE_CLIENT_ID: "user-assigned",
      }),
    ).toEqual({ kind: "managed-identity", clientId: "user-assigned" });
  });

  it("requires the fields of the chosen kind", () => {
    expect(() => entraAuthFromEnv({ OBJECT_STORAGE_AUTH: "client-secret", ...principal })).toThrow(
      /client-secret requires OBJECT_STORAGE_SECRET_ACCESS_KEY/,
    );
    expect(() =>
      entraAuthFromEnv({ OBJECT_STORAGE_AUTH: "client-certificate", ...principal }),
    ).toThrow(/client-certificate requires OBJECT_STORAGE_CERTIFICATE/);
    expect(() => entraAuthFromEnv({ OBJECT_STORAGE_AUTH: "federated-identity" })).toThrow(
      /federated-identity requires OBJECT_STORAGE_TENANT and OBJECT_STORAGE_CLIENT_ID and OBJECT_STORAGE_FEDERATED_TOKEN_FILE/,
    );
  });

  it("rejects an unknown kind", () => {
    expect(() => entraAuthFromEnv({ OBJECT_STORAGE_AUTH: "browser" })).toThrow(
      /OBJECT_STORAGE_AUTH must be/,
    );
  });
});

describe("entraCredential", () => {
  const certificate = readFileSync(
    new URL("./azure-entra-test-certificate.pem", import.meta.url),
    "utf8",
  );

  it("builds the SDK credential for a client secret", async () => {
    const identity = await import("@azure/identity");
    const credential = await entraCredential({
      kind: "client-secret",
      tenant: "directory",
      clientId: "principal",
      clientSecret: "secret",
    });
    expect(credential).toBeInstanceOf(identity.ClientSecretCredential);
  });

  it("builds the SDK credential for a certificate, inline and from a file", async () => {
    const identity = await import("@azure/identity");
    const inline = await entraCredential({
      kind: "client-certificate",
      tenant: "directory",
      clientId: "principal",
      certificate,
    });
    expect(inline).toBeInstanceOf(identity.ClientCertificateCredential);
    const fromFile = await entraCredential({
      kind: "client-certificate",
      tenant: "directory",
      clientId: "principal",
      certificate: new URL("./azure-entra-test-certificate.pem", import.meta.url).pathname,
    });
    expect(fromFile).toBeInstanceOf(identity.ClientCertificateCredential);
  });

  it("fails clearly when the certificate holds no PEM bundle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "entra-"));
    try {
      const path = join(directory, "empty.pem");
      writeFileSync(path, "not a certificate");
      await expect(
        entraCredential({
          kind: "client-certificate",
          tenant: "directory",
          clientId: "principal",
          certificate: path,
        }),
      ).rejects.toThrow(/PEM bundle/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds the SDK credential for a federated workload identity and managed identities", async () => {
    const identity = await import("@azure/identity");
    expect(
      await entraCredential({
        kind: "federated-identity",
        tenant: "directory",
        clientId: "principal",
        tokenFile: "/var/run/secrets/tokens/oidc-token",
      }),
    ).toBeInstanceOf(identity.WorkloadIdentityCredential);
    expect(await entraCredential({ kind: "managed-identity" })).toBeInstanceOf(
      identity.ManagedIdentityCredential,
    );
    expect(
      await entraCredential({ kind: "managed-identity", clientId: "user-assigned" }),
    ).toBeInstanceOf(identity.ManagedIdentityCredential);
  });

  it("passes an injected credential through untouched", async () => {
    const credential = { getToken: async () => ({ token: "t", expiresOnTimestamp: 0 }) };
    expect(await entraCredential({ kind: "token", credential })).toBe(credential);
  });
});
