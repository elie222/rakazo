import { createHash } from "node:crypto";
import type { Pool } from "@rakazo/db";
import type { Auth } from "./index.js";

export interface CompanyOsOAuthConfig {
  origin: string;
  clientId: string;
  clientSecret: string;
}
export interface CompanyOsIdentity {
  sub: string;
  name: string;
  email: string;
  email_verified: true;
  client_id: string;
  company: { id: string; name: string; slug: string };
  capabilities: string[];
}
export function companyOsOAuthFromEnv(source = process.env): CompanyOsOAuthConfig | undefined {
  if (source.AUTH_PROVIDER !== "convex-company-os") return undefined;
  const origin = new URL(source.COMPANY_OS_OAUTH_ORIGIN ?? "https://www.companyos.sh");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Company OS OAuth requires an HTTPS origin");
  if (!source.COMPANY_OS_OAUTH_CLIENT_ID || !source.COMPANY_OS_OAUTH_CLIENT_SECRET)
    throw new Error("Company OS OAuth client is not configured");
  return {
    origin: origin.origin,
    clientId: source.COMPANY_OS_OAUTH_CLIENT_ID,
    clientSecret: source.COMPANY_OS_OAUTH_CLIENT_SECRET,
  };
}
export async function companyOsIdentity(
  config: CompanyOsOAuthConfig,
  accessToken: string,
  fetcher = fetch,
): Promise<CompanyOsIdentity> {
  const response = await fetcher(`${config.origin}/api/oauth/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error("Company OS authorization is unavailable. Reconnect to continue.");
  const value = (await response.json()) as Partial<CompanyOsIdentity>;
  if (
    typeof value.sub !== "string" ||
    !value.sub ||
    value.client_id !== config.clientId ||
    value.email_verified !== true ||
    typeof value.email !== "string" ||
    !value.email.includes("@") ||
    !value.company?.id ||
    !value.company.slug ||
    !value.company.name ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((c) => typeof c === "string")
  )
    throw new Error("Company OS returned an invalid verified identity");
  return value as CompanyOsIdentity;
}
export function companyOsSubject(config: CompanyOsOAuthConfig, subject: string) {
  return createHash("sha256").update(`${config.origin}\0${subject}`).digest("hex");
}

/** One refresh at a time across API and worker processes: refresh tokens are single-use. */
export function createCompanyOsCredential(auth: Auth, config: CompanyOsOAuthConfig, pool: Pool) {
  return async (userId: string) => {
    const lock = await pool.connect();
    const name = `cadre-oauth:${userId}`;
    let held = false;
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [name]);
      held = true;
      const token = await auth.api.getAccessToken({ body: { providerId: "company-os", userId } });
      const identity = await companyOsIdentity(config, token.accessToken);
      return { token: token.accessToken, identity };
    } finally {
      try {
        if (held) await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [name]);
        lock.release();
      } catch {
        lock.release(true);
      }
    }
  };
}
