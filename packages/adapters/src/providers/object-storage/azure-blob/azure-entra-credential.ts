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
  | { kind: "managed-identity"; clientId?: string }
  /** An existing token credential, for callers and tests that hold one already. Not from env. */
  | { kind: "token"; credential: EntraTokenCredential };

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
        certificate: certificate!,
      };
    }
    case "federated-identity": {
      const tokenFile = env.OBJECT_STORAGE_FEDERATED_TOKEN_FILE?.trim();
      need({
        OBJECT_STORAGE_TENANT: tenant,
        OBJECT_STORAGE_CLIENT_ID: clientId,
        OBJECT_STORAGE_FEDERATED_TOKEN_FILE: tokenFile,
      });
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
  if (config.kind === "token") return config.credential;
  const identity = await import("@azure/identity");
  switch (config.kind) {
    case "client-secret":
      return new identity.ClientSecretCredential(
        config.tenant,
        config.clientId,
        config.clientSecret,
      );
    case "client-certificate": {
      // A PEM bundle inline, or a path to one: anything else is read from the file. The SDK
      // parses the certificate lazily, so the bundle is checked here, where a mistake in the
      // settings fails at startup instead of on the first upload.
      const certificate = (
        config.certificate.startsWith("-----BEGIN")
          ? config.certificate
          : readFileSync(config.certificate, "utf8")
      ).trim();
      if (!/^-----BEGIN [^-]+-----$/m.test(certificate))
        throw new Error("OBJECT_STORAGE_CERTIFICATE must hold a PEM bundle");
      return new identity.ClientCertificateCredential(config.tenant, config.clientId, {
        certificate,
      });
    }
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
