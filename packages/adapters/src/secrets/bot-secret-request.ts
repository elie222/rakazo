import type { SecretStore } from "@rakazo/adapter-kit";
import { commandVariableName, isPrivateNetworkHost, SecretHttpRequest } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { combineSignals, redactConnectorPayload } from "../integrations/connector-safety.js";
import type { RemoteTransportDependencies } from "../mcp/remote-mcp.js";
import {
  ConnectorRedirectError,
  createPrivateNetworkFetch,
  createSafeRemoteFetch,
  RemoteRequestSentError,
} from "../mcp/remote-mcp.js";
import { readBodyCapped, withAbort } from "../web/web-ssrf.js";
import {
  allowPrivateHttpSecretOrigins,
  credentialHeader,
  normalizeSecretDestination,
  UNUSABLE_CREDENTIAL,
} from "./bot-secret-destination.js";
import type { BotSecretScope, VaultItemUse } from "./vault/vault-access.js";
import { usableVaultFields } from "./vault/vault-access.js";
import { apiKeyRedactionForms } from "./vault/vault-redaction.js";
import { openVaultValue } from "./vault/vault-values.js";

/** Response headers APIs page and rate-limit with. Other headers can echo request values. */
const PAGING_HEADERS = [
  "content-range",
  "retry-after",
  "x-next-page",
  "x-page",
  "x-per-page",
  "x-total",
  "x-total-count",
  "x-total-pages",
] as const;

/** A longer link or paging header value is dropped rather than crowd out the body. */
const MAX_PAGING_VALUE_CHARS = 2_000;
/** All returned links and paging headers together; past this, the less useful ones are left out. */
const MAX_PAGING_TOTAL_CHARS = 6_000;

/**
 * The entries of a `Link` header (RFC 8288) as their target and lowercased parameters. Quoted
 * parameter values may hold commas and semicolons; the first occurrence of a parameter counts.
 */
export function linkHeaderEntries(
  header: string,
): { target: string; params: Map<string, string> }[] {
  const entries: { target: string; params: Map<string, string> }[] = [];
  let i = 0;
  const skipSpace = () => {
    while (i < header.length && /[ \t]/.test(header[i]!)) i++;
  };
  // Skips to the next top-level `;` or `,`, stepping over quoted strings.
  const skipValue = () => {
    while (i < header.length && header[i] !== ";" && header[i] !== ",") {
      if (header[i] === '"') readQuoted();
      else i++;
    }
  };
  const readQuoted = () => {
    let value = "";
    i++;
    while (i < header.length && header[i] !== '"') {
      if (header[i] === "\\" && i + 1 < header.length) i++;
      value += header[i++];
    }
    i++;
    return value;
  };
  while (i < header.length) {
    skipSpace();
    if (header[i] !== "<") {
      // Not an entry start: skip to the next top-level separator.
      skipValue();
      i++;
      continue;
    }
    const end = header.indexOf(">", i);
    if (end === -1) break;
    const target = header.slice(i + 1, end).trim();
    i = end + 1;
    const params = new Map<string, string>();
    for (;;) {
      skipSpace();
      if (header[i] !== ";") break;
      i++;
      skipSpace();
      const nameStart = i;
      while (i < header.length && !/[=;,\s]/.test(header[i]!)) i++;
      const name = header.slice(nameStart, i).toLowerCase();
      skipSpace();
      let value = "";
      if (header[i] === "=") {
        i++;
        skipSpace();
        if (header[i] === '"') value = readQuoted();
        else {
          const valueStart = i;
          while (i < header.length && !/[;,\s]/.test(header[i]!)) i++;
          value = header.slice(valueStart, i);
        }
      }
      if (name && !params.has(name)) params.set(name, value);
    }
    skipValue();
    if (header[i] === ",") i++;
    entries.push({ target, params });
  }
  return entries;
}

/**
 * Where a paged API says the rest is: `links` from the `Link` header by relation, resolved
 * against the request URL (Canvas and GitHub put the next page there), and `headers` for the
 * other paging headers present. A value too long, a link that is not http(s), or anything that
 * carries the credential is left out.
 */
export function responsePaging(
  headers: Headers,
  requestUrl: string,
  secrets: readonly string[] = [],
): { links?: Record<string, string>; headers?: Record<string, string> } {
  // A Map, so a relation named like an Object property (constructor, __proto__) is kept as given.
  const links = new Map<string, string>();
  for (const { target, params } of linkHeaderEntries(headers.get("link") ?? "")) {
    let url: URL;
    try {
      url = new URL(target, requestUrl);
    } catch {
      continue;
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.href.length > MAX_PAGING_VALUE_CHARS ||
      carriesSecret(target, secrets) ||
      carriesSecret(url.href, secrets)
    )
      continue;
    // Registered relation names compare case-insensitively; extension relations are URIs.
    for (const rel of params.get("rel")?.split(/\s+/) ?? []) {
      const name = /[:/]/.test(rel) ? rel : rel.toLowerCase();
      // An extension relation is a URI too, and can carry the credential like the link.
      if (name && !links.has(name) && !carriesSecret(name, secrets)) links.set(name, url.href);
    }
  }
  const found = new Map<string, string>();
  for (const name of PAGING_HEADERS) {
    const value = headers.get(name);
    if (value !== null && value.length <= MAX_PAGING_VALUE_CHARS && !carriesSecret(value, secrets))
      found.set(name, value);
  }
  let budget = MAX_PAGING_TOTAL_CHARS;
  const withinBudget = (entries: Iterable<[string, string]>) => {
    const kept: [string, string][] = [];
    for (const [name, value] of entries) {
      const size = name.length + value.length;
      if (size > budget) continue;
      budget -= size;
      kept.push([name, value]);
    }
    return kept;
  };
  // The next page first, then the paging headers, then the other links.
  const next = links.get("next");
  const keptNext = withinBudget(next === undefined ? [] : [["next", next]]);
  const keptHeaders = withinBudget(found);
  const keptLinks = [...keptNext, ...withinBudget([...links].filter(([name]) => name !== "next"))];
  return {
    ...(keptLinks.length ? { links: Object.fromEntries(keptLinks) } : {}),
    ...(keptHeaders.length ? { headers: Object.fromEntries(keptHeaders) } : {}),
  };
}

/**
 * Whether a value holds any form of a credential, compared case-insensitively and also after
 * percent-decoding (any case of escape, repeated), so an echo the body redaction would miss is
 * caught. A link or header that does is left out whole: with the value replaced it would not work.
 */
function carriesSecret(value: string, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  const forms = [value, value.replace(/\+/g, " ")];
  let decoded = value;
  for (let round = 0; round < 3; round++) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
    if (next === decoded) break;
    forms.push(next, next.replace(/\+/g, " "));
    decoded = next;
  }
  const haystacks = forms.map((form) => form.toLowerCase());
  return secrets.some((secret) => {
    const needle = secret.toLowerCase();
    return needle.length > 0 && haystacks.some((haystack) => haystack.includes(needle));
  });
}

/** Credentials are resolved only inside this destination-bound HTTP boundary. */
export async function requestWithBotSecret(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  request: unknown;
  signal: AbortSignal;
  remote?: RemoteTransportDependencies;
  registerRedactions?: (values: string[]) => void;
  recordUse?: (item: VaultItemUse, site: string) => Promise<void>;
}): Promise<unknown> {
  const request = SecretHttpRequest.parse(input.request);
  const row = await input.prisma.vaultCredential.findFirst({
    where: { ...(await usableVaultFields(input.prisma, input.scope)), name: request.name },
  });
  if (!row) return { error: "Credential is unavailable. Use request_secret to save it first." };
  const destination = normalizeSecretDestination(row);
  if (destination.auth.type === "login") {
    return { error: "Website logins can only be filled into their site with browser_act." };
  }
  if (destination.auth.type === "command") {
    return {
      error: `${UNUSABLE_CREDENTIAL}. Command variables are only available to shell commands, as $${commandVariableName(destination.name)}.`,
    };
  }
  const url = new URL(request.url);
  if (url.origin !== destination.origin || url.username || url.password || url.hash) {
    return { error: "This credential cannot be sent to that destination." };
  }
  const controller = new AbortController();
  const signal = combineSignals(input.signal, controller.signal, AbortSignal.timeout(30_000));
  const plaintext = await openVaultValue(input.prisma, input.secretStore, row, signal);
  const headers = new Headers({ accept: "application/json", "content-type": request.contentType });
  const { name: headerName, value: headerValue } = credentialHeader(destination, plaintext);
  const redactions = apiKeyRedactionForms(destination, plaintext);
  input.registerRedactions?.(redactions);
  // Once the request may have gone out, so one refused before sending isn't a use.
  let recorded = false;
  const recordUse = async () => {
    if (recorded) return;
    recorded = true;
    await input.recordUse?.(
      { id: row.id, name: row.name, spaceId: row.spaceId, kind: destination.auth.type },
      destination.origin,
    );
  };
  // The safe fetch refuses plain-HTTP and private hosts outright. A credential
  // saved under the owner's private-HTTP opt-in was validated against exactly
  // those rules at save time, and the request URL is pinned to its origin, so
  // deliver it through the inverted transport instead — it re-checks that every
  // resolved address is private (metadata endpoints stay blocked) and pins the
  // connection to the validated answer.
  const privateHttpDestination =
    allowPrivateHttpSecretOrigins() &&
    url.protocol === "http:" &&
    isPrivateNetworkHost(url.hostname);
  // Cancelled while the destination is still being checked, nothing is sent, then or after.
  let sent = false;
  const beforeSend = () => {
    signal.throwIfAborted();
    sent = true;
  };
  const fetch = privateHttpDestination
    ? createPrivateNetworkFetch(input.remote?.fetch, input.remote?.resolveHostname, beforeSend)
    : createSafeRemoteFetch(
        input.remote?.fetch,
        input.remote?.resolveHostname,
        undefined,
        beforeSend,
      );
  try {
    headers.set(headerName, headerValue);
    const response = await withAbort(
      fetch(url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal,
      }),
      signal,
    );
    await recordUse();
    const bytes = await readBodyCapped(response, 1_000_000, signal);
    const text = new TextDecoder().decode(bytes);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* Plain text responses are supported. */
    }
    // Redact before truncating, so an output boundary cannot expose part of a value.
    const safe = JSON.stringify(redactConnectorPayload(body, redactions));
    const paging = redactConnectorPayload(
      responsePaging(response.headers, url.href, redactions),
      redactions,
    ) as Record<string, unknown>;
    return {
      status: response.status,
      ...paging,
      body: safe.length > 20_000 ? safe.slice(0, 20_000) : JSON.parse(safe),
      truncated: safe.length > 20_000,
    };
  } catch (error) {
    // Sent and cut off, redirected, or cancelled or timed out while out: the key may have
    // reached the site.
    if (
      error instanceof RemoteRequestSentError ||
      error instanceof ConnectorRedirectError ||
      (sent && signal.aborted)
    )
      await recordUse();
    return { error: "Authenticated request failed. Check the destination and credential." };
  } finally {
    controller.abort();
    await bestEffort(
      "close the secret request transport",
      withAbort(fetch.close(), AbortSignal.timeout(1000)),
    );
  }
}
