import * as z from "zod";

export const SERVICE_SCOPES = [
  "bots:read",
  "bots:write",
  "conversations:read",
  "prompts:write",
  "computer:read",
  "computer:write",
  "memory:read",
  "memory:write",
  "routines:read",
  "routines:write",
  "artifacts:read",
  "scratchpad:read",
  "scratchpad:write",
  "skills:read",
  "pages:read",
  "groups:read",
  "groups:write",
  "tickets:read",
  "tickets:write",
  "usage:read",
  "search:read",
  "audit:read",
] as const;
export const ServiceScopeSchema = z.enum(SERVICE_SCOPES);
export type ServiceScope = z.infer<typeof ServiceScopeSchema>;

/** The read scope a write scope includes, where the area has one. */
export function readScopeOf(scope: ServiceScope): ServiceScope | null {
  if (!scope.endsWith(":write")) return null;
  const read = scope.replace(/:write$/, ":read");
  return (SERVICE_SCOPES as readonly string[]).includes(read) ? (read as ServiceScope) : null;
}

/**
 * A write answers with what it wrote, so a key that may write an area may also read it. Without
 * this, a write-only key could read anything back by writing it unchanged.
 */
export function withReadScopes(scopes: readonly ServiceScope[]): ServiceScope[] {
  const all = new Set(scopes);
  for (const scope of scopes) {
    const read = readScopeOf(scope);
    if (read) all.add(read);
  }
  return SERVICE_SCOPES.filter((scope) => all.has(scope));
}

/** Keys always expire, so a forgotten one cannot outlive its purpose. Rotate by overlapping two. */
export const SERVICE_CREDENTIAL_MAX_DAYS = 365;
export const SERVICE_CREDENTIALS_PER_MEMBER = 25;

export const ServiceCredentialSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenPrefix: z.string(),
  scopes: z.array(ServiceScopeSchema),
  /** Empty means every bot the member has in the space. */
  botIds: z.array(z.string()),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ServiceCredential = z.infer<typeof ServiceCredentialSchema>;

export const CreateServiceCredentialInput = z.object({
  name: z.string().trim().min(1).max(60),
  scopes: z.array(ServiceScopeSchema).min(1),
  botIds: z.array(z.string().min(1)).max(200).default([]),
  expiresInDays: z.number().int().min(1).max(SERVICE_CREDENTIAL_MAX_DAYS),
});
