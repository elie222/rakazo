import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as IdentitySdk from "@azure/identity";
import { describe, expect, it } from "vitest";
import { entraAuthFromEnv, entraCredential } from "./azure-entra-credential.js";

/** The bundle the certificate kind must read and check while the settings are parsed. */
const certificate = readFileSync(
  new URL("./azure-entra-test-certificate.pem", import.meta.url),
  "utf8",
);

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

  it("reads a service principal with a certificate, inline and from a file", () => {
    expect(
      entraAuthFromEnv({
        OBJECT_STORAGE_AUTH: "client-certificate",
        ...principal,
        OBJECT_STORAGE_CERTIFICATE: certificate,
      }),
    ).toEqual({
      kind: "client-certificate",
      tenant: "directory",
      clientId: "principal",
      certificate: certificate.trim(),
    });
    expect(
      entraAuthFromEnv({
        OBJECT_STORAGE_AUTH: "client-certificate",
        ...principal,
        OBJECT_STORAGE_CERTIFICATE: fileURLToPath(
          new URL("./azure-entra-test-certificate.pem", import.meta.url),
        ),
      }),
    ).toEqual({
      kind: "client-certificate",
      tenant: "directory",
      clientId: "principal",
      certificate: certificate.trim(),
    });
    // A bundle exported or edited on Windows keeps CRLF endings; it must parse all the same.
    expect(() =>
      entraAuthFromEnv({
        OBJECT_STORAGE_AUTH: "client-certificate",
        ...principal,
        OBJECT_STORAGE_CERTIFICATE: certificate.split("\n").join("\r\n"),
      }),
    ).not.toThrow();
    // Env files, docker -e and systemd EnvironmentFile carry the bundle on one line.
    expect(() =>
      entraAuthFromEnv({
        OBJECT_STORAGE_AUTH: "client-certificate",
        ...principal,
        OBJECT_STORAGE_CERTIFICATE: certificate.split("\n").join("\\n"),
      }),
    ).not.toThrow();
  });

  it("fails at startup when the certificate is missing or malformed", () => {
    expect(() =>
      entraAuthFromEnv({
        OBJECT_STORAGE_AUTH: "client-certificate",
        ...principal,
        OBJECT_STORAGE_CERTIFICATE: "/certs/not-there.pem",
      }),
    ).toThrow(/neither a readable PEM file nor an inline PEM bundle/);
    // A value without a PEM header — a base64 bundle, as Kubernetes secrets often hold them —
    // must fail without the value leaking into the error, private key included.
    const base64 = Buffer.from(certificate).toString("base64");
    try {
      entraAuthFromEnv({
        OBJECT_STORAGE_AUTH: "client-certificate",
        ...principal,
        OBJECT_STORAGE_CERTIFICATE: base64,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(base64.slice(0, 60));
    }
    const directory = mkdtempSync(join(tmpdir(), "entra-"));
    try {
      const mismatched = `${certificate.split("-----BEGIN PRIVATE KEY-----")[0]}${generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "sec1", format: "pem" })}`;
      const cases: [string, string][] = [
        ["no PEM at all", "not a certificate"],
        ["headers without bodies", "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----"],
        [
          "a certificate without its private key",
          certificate.split("-----BEGIN PRIVATE KEY-----")[0]!,
        ],
        [
          "garbage inside valid-looking headers",
          `-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----\n${generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "sec1", format: "pem" })}`,
        ],
        ["a certificate paired with another key", mismatched],
        [
          "a password-protected key",
          `${certificate.split("-----BEGIN PRIVATE KEY-----")[0]}-----BEGIN ENCRYPTED PRIVATE KEY-----\nnot really\n-----END ENCRYPTED PRIVATE KEY-----\n`,
        ],
      ];
      for (const [name, contents] of cases) {
        const path = join(directory, `${name.replace(/\W+/g, "-")}.pem`);
        writeFileSync(path, contents);
        expect(
          () =>
            entraAuthFromEnv({
              OBJECT_STORAGE_AUTH: "client-certificate",
              ...principal,
              OBJECT_STORAGE_CERTIFICATE: path,
            }),
          name,
        ).toThrow(/PEM bundle|not usable|do not pair/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads a federated workload identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "entra-"));
    try {
      const tokenFile = join(directory, "oidc-token");
      writeFileSync(tokenFile, "projected service account token");
      expect(
        entraAuthFromEnv({
          OBJECT_STORAGE_AUTH: "federated-identity",
          ...principal,
          OBJECT_STORAGE_FEDERATED_TOKEN_FILE: tokenFile,
        }),
      ).toEqual({
        kind: "federated-identity",
        tenant: "directory",
        clientId: "principal",
        tokenFile,
      });
      expect(() =>
        entraAuthFromEnv({
          OBJECT_STORAGE_AUTH: "federated-identity",
          ...principal,
          OBJECT_STORAGE_FEDERATED_TOKEN_FILE: join(directory, "not-mounted"),
        }),
      ).toThrow(/OBJECT_STORAGE_FEDERATED_TOKEN_FILE could not be read/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
  it("builds the SDK credential for a client secret", async () => {
    const credential = await entraCredential({
      kind: "client-secret",
      tenant: "directory",
      clientId: "principal",
      clientSecret: "secret",
    });
    expect(credential).toBeInstanceOf(IdentitySdk.ClientSecretCredential);
  });

  it("builds the SDK credential for a certificate", async () => {
    // A throwaway key minted for this test: construction stores the material, and nothing
    // reaches the network, so its shape — not its identity — is what matters here.
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const credential = await entraCredential({
      kind: "client-certificate",
      tenant: "directory",
      clientId: "principal",
      certificate: privateKey.export({ type: "sec1", format: "pem" }) as string,
    });
    expect(credential).toBeInstanceOf(IdentitySdk.ClientCertificateCredential);
  });

  it("builds the SDK credential for a federated workload identity and managed identities", async () => {
    expect(
      await entraCredential({
        kind: "federated-identity",
        tenant: "directory",
        clientId: "principal",
        tokenFile: "/var/run/secrets/tokens/oidc-token",
      }),
    ).toBeInstanceOf(IdentitySdk.WorkloadIdentityCredential);
    expect(await entraCredential({ kind: "managed-identity" })).toBeInstanceOf(
      IdentitySdk.ManagedIdentityCredential,
    );
    expect(
      await entraCredential({ kind: "managed-identity", clientId: "user-assigned" }),
    ).toBeInstanceOf(IdentitySdk.ManagedIdentityCredential);
  });
});
