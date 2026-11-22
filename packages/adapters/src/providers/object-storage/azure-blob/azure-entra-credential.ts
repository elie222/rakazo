import type { KeyObject } from "node:crypto";
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * How a server authenticates to Entra ID (any OIDC directory): a service principal with a client
 * secret, a certificate or a federated workload token, or the platform's managed identity. The
 * interactive, browser and CLI credential types are developer conveniences and deliberately not
 * offered: a server must not borrow whoever is logged in.
 */
export type EntraAuthConfig =
  | { kind: "client-secret"; tenant: string; clientId: string; clientSecret: string }
  | { kind: "client-certificate"; tenant: string; clientId: string; certificate: string }
  | { kind: "federated-identity"; tenant: string; clientId: string; tokenFile: string }
  | { kind: "managed-identity"; clientId?: string };

/**
 * The shape of the SDK's token credentials, mirroring the storage SDK's accepted credential so
 * the Entra kinds slot straight into the service client. No SDK type reaches a static import.
 */
export interface EntraTokenCredential {
  getToken(
    scopes: string | string[],
    options?: unknown,
  ): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}

const KINDS =
  '"account-key", "client-secret", "client-certificate", "federated-identity" or "managed-identity"';

/**
 * An Entra kind selected while another protocol is active must not be silently ignored: the S3
 * backend would sign its requests with whatever the settings hold. Only the Azure module knows
 * what an Entra kind is, so the shared factory forwards here. Storage turned off (no bucket)
 * ignores every setting, as before.
 */
export function refuseEntraAuthUnderOtherProtocol(env: NodeJS.ProcessEnv): void {
  const auth = env.OBJECT_STORAGE_AUTH?.trim().toLowerCase() || "account-key";
  if (auth !== "account-key" && env.OBJECT_STORAGE_BUCKET?.trim())
    throw new Error(
      "OBJECT_STORAGE_AUTH applies only with OBJECT_STORAGE_PROTOCOL=azure-blob; unset it for S3",
    );
}

/**
 * Reads and checks the certificate here, while the settings are parsed, so a missing file, a
 * malformed bundle or an unusable key fails at startup instead of on the first upload: the SDK
 * parses it lazily. Accepts the PEM bundle inline, or a path to one.
 */
function certificateBundle(value: string): string {
  let certificate: string;
  try {
    // A PEM bundle inline, or a path to one. Env files, docker -e and systemd EnvironmentFile
    // carry multi-line values on one line with escaped newlines, so decode those.
    const raw = value.includes("-----BEGIN") ? value : readFileSync(value, "utf8");
    certificate = raw.replace(/\\r\\n|\\n/g, "\n").trim();
  } catch {
    // A value without a PEM header lands here read as a path, and the filesystem error's
    // message would repeat the whole value — private key included — into startup logs, so the
    // error never echoes it. Base64-encoded bundles (as Kubernetes secrets often hold them)
    // must be decoded before they are set.
    throw new Error(
      "OBJECT_STORAGE_CERTIFICATE is neither a readable PEM file nor an inline PEM bundle; decode base64 bundles before setting them",
    );
  }
  if (!certificate.includes("-----BEGIN CERTIFICATE-----") || !/PRIVATE KEY-----/.test(certificate))
    throw new Error(
      "OBJECT_STORAGE_CERTIFICATE must hold a PEM bundle with a certificate and its private key",
    );
  // Prove both blocks parse and pair, so garbage inside valid-looking headers, a
  // password-protected key and a key from another certificate (a rotation mix-up) fail here.
  let pair: [X509Certificate, KeyObject];
  try {
    pair = [new X509Certificate(certificate), createPublicKey(createPrivateKey(certificate))];
  } catch (error) {
    throw new Error(`OBJECT_STORAGE_CERTIFICATE is not usable: ${(error as Error).message}`);
  }
  const spki = (key: KeyObject) => key.export({ type: "spki", format: "der" });
  if (!spki(pair[0].publicKey).equals(spki(pair[1])))
    throw new Error("OBJECT_STORAGE_CERTIFICATE's certificate and private key do not pair");
  return certificate;
}

/**
 * `OBJECT_STORAGE_AUTH` picks how the Azure Blob backend authenticates: unset (or `account-key`)
 * keeps the storage account key, and every other value is an Entra ID kind whose required
 * settings it validates here. Returns undefined for the account-key default.
 */
export function entraAuthFromEnv(env: NodeJS.ProcessEnv): EntraAuthConfig | undefined {
  const auth = env.OBJECT_STORAGE_AUTH?.trim().toLowerCase();
  if (!auth || auth === "account-key") return undefined;
  const tenant = env.OBJECT_STORAGE_TENANT?.trim();
  const clientId = env.OBJECT_STORAGE_CLIENT_ID?.trim();
  const need = (fields: Record<string, string | undefined>) => {
    const missing = Object.entries(fields)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length)
      throw new Error(`OBJECT_STORAGE_AUTH=${auth} requires ${missing.join(" and ")}`);
  };
  switch (auth) {
    case "client-secret": {
      const clientSecret = env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim();
      need({
        OBJECT_STORAGE_TENANT: tenant,
        OBJECT_STORAGE_CLIENT_ID: clientId,
        OBJECT_STORAGE_SECRET_ACCESS_KEY: clientSecret,
      });
      return {
        kind: "client-secret",
        tenant: tenant!,
        clientId: clientId!,
        clientSecret: clientSecret!,
      };
    }
    case "client-certificate": {
      const certificate = env.OBJECT_STORAGE_CERTIFICATE?.trim();
      need({
        OBJECT_STORAGE_TENANT: tenant,
        OBJECT_STORAGE_CLIENT_ID: clientId,
        OBJECT_STORAGE_CERTIFICATE: certificate,
      });
      return {
        kind: "client-certificate",
        tenant: tenant!,
        clientId: clientId!,
        certificate: certificateBundle(certificate!),
      };
    }
    case "federated-identity": {
      const tokenFile = env.OBJECT_STORAGE_FEDERATED_TOKEN_FILE?.trim();
      need({
        OBJECT_STORAGE_TENANT: tenant,
        OBJECT_STORAGE_CLIENT_ID: clientId,
        OBJECT_STORAGE_FEDERATED_TOKEN_FILE: tokenFile,
      });
      // The SDK reads the token on each request; prove the file is readable now, so a missing
      // mount fails at startup instead of on the first home save.
      try {
        readFileSync(tokenFile!);
      } catch (error) {
        throw new Error(
          `OBJECT_STORAGE_FEDERATED_TOKEN_FILE could not be read: ${(error as Error).message}`,
        );
      }
      return {
        kind: "federated-identity",
        tenant: tenant!,
        clientId: clientId!,
        tokenFile: tokenFile!,
      };
    }
    case "managed-identity":
      return clientId ? { kind: "managed-identity", clientId } : { kind: "managed-identity" };
    default:
      throw new Error(`OBJECT_STORAGE_AUTH must be ${KINDS}`);
  }
}

/**
 * Builds the SDK credential for a kind. The SDK loads on first use, like the storage SDK, so
 * deployments without object storage never load it.
 */
export async function entraCredential(config: EntraAuthConfig): Promise<EntraTokenCredential> {
  const identity = await import("@azure/identity");
  switch (config.kind) {
    case "client-secret":
      return new identity.ClientSecretCredential(
        config.tenant,
        config.clientId,
        config.clientSecret,
      );
    case "client-certificate":
      // The bundle was read and checked when the settings were parsed; the SDK parses it
      // lazily, on the first token request.
      return new identity.ClientCertificateCredential(config.tenant, config.clientId, {
        certificate: config.certificate,
      });
    case "federated-identity":
      return new identity.WorkloadIdentityCredential({
        tenantId: config.tenant,
        clientId: config.clientId,
        tokenFilePath: config.tokenFile,
      });
    case "managed-identity":
      return config.clientId
        ? new identity.ManagedIdentityCredential(config.clientId)
        : new identity.ManagedIdentityCredential();
  }
}
