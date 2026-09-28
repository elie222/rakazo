import { randomBytes } from "node:crypto";
import type { BotSecretDestination } from "@rakazo/contracts";
import {
  botSecretDestinationSchema,
  decodeLoginSecret,
  isPrivateNetworkHost,
  SecretHttpRequest,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { combineSignals, redactConnectorPayload } from "./connector-safety.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { createPrivateNetworkFetch, createSafeRemoteFetch } from "./remote-mcp.js";
import type { EncryptedSecretStore } from "./secrets.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

export type BotSecretScope = { userId: string; spaceId: string; botId: string };
function scopeFields({ userId, spaceId, botId }: BotSecretScope): BotSecretScope {
  return { userId, spaceId, botId };
}

const metadata = { name: true, origin: true, auth: true } as const;

function credentialHeader(destination: BotSecretDestination, plaintext: string) {
  if (destination.auth.type === "login") {
    throw new Error("Credential cannot be used with this authentication method");
  }
  const name = destination.auth.type === "header" ? destination.auth.name : "Authorization";
  const value =
    destination.auth.type === "bearer"
      ? `Bearer ${plaintext}`
      : destination.auth.type === "basic"
        ? `Basic ${Buffer.from(`${destination.auth.username}:${plaintext}`).toString("base64")}`
        : plaintext;
  try {
    const headers = new Headers({ [name]: value });
    if (headers.get(name) !== value) throw new Error("Header value was normalized");
  } catch {
    throw new Error("Credential cannot be used with this authentication method");
  }
  return { name, value };
}

/** Owner escape enabling plain-HTTP origins on private LAN hosts (see #907). */
export function allowPrivateHttpSecretOrigins(): boolean {
  return process.env.RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP === "1";
}

export function normalizeSecretDestination(value: unknown): BotSecretDestination {
  const parsed = botSecretDestinationSchema({
    allowPrivateHttpOrigin: allowPrivateHttpSecretOrigins(),
  }).safeParse(value);
  if (!parsed.success) {
    // Surface the actual failing field: models (and people) supply all three
    // parts and still fail on a name character or an origin rule, and a
    // generic "specify name, origin, auth" error sends them retrying blind.
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "credential"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid credential destination — ${detail}`);
  }
  return { ...parsed.data, origin: new URL(parsed.data.origin).origin };
}

export function sameSecretDestination(
  left: BotSecretDestination,
  right: BotSecretDestination,
): boolean {
  return (
    left.name === right.name &&
    left.origin === right.origin &&
    JSON.stringify(left.auth) === JSON.stringify(right.auth)
  );
}

export async function findBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  const row = await prisma.botSecret.findFirst({
    where: { ...scopeFields(scope), name },
    select: metadata,
  });
  return row ? normalizeSecretDestination(row) : null;
}

export async function storeBotSecret(input: {
  tx: Prisma.TransactionClient;
  secretStore: EncryptedSecretStore;
  scope: BotSecretScope;
  destination: BotSecretDestination;
  plaintext: string;
}): Promise<void> {
  const { tx, secretStore, scope, plaintext } = input;
  if (!plaintext || plaintext.length > 16_384) throw new Error("Invalid credential length");
  const destination = normalizeSecretDestination(input.destination);
  if (destination.auth.type === "login") decodeLoginSecret(plaintext);
  else credentialHeader(destination, plaintext);
  // Serialize credential updates and deletions for a bot, including concurrent first saves.
  await tx.$queryRaw`SELECT id FROM bots WHERE id = ${scope.botId} FOR UPDATE`;
  const existing = await tx.botSecret.findFirst({
    where: { ...scopeFields(scope), name: destination.name },
  });
  if (existing && !sameSecretDestination(normalizeSecretDestination(existing), destination)) {
    throw new Error("Remove the existing credential before changing its destination");
  }
  if (!existing && (await tx.botSecret.count({ where: scopeFields(scope) })) >= 100) {
    throw new Error("Credential limit reached");
  }
  const id = existing?.id ?? randomBytes(12).toString("hex");
  const encrypted = await secretStore.put(
    plaintext,
    {
      operationId: id,
      traceId: id,
      userId: scope.userId,
      spaceId: scope.spaceId,
      signal: new AbortController().signal,
    },
    id,
  );
  if (existing) {
    await tx.botSecret.update({ where: { id }, data: { ciphertext: encrypted.ciphertext } });
  } else {
    await tx.botSecret.create({
      data: { id, ...scopeFields(scope), ...destination, ciphertext: encrypted.ciphertext },
    });
  }
}

export function listBotSecrets(prisma: PrismaClient, scope: BotSecretScope) {
  return prisma.botSecret.findMany({
    where: scopeFields(scope),
    select: metadata,
    orderBy: { name: "asc" },
    take: 100,
  });
}

export async function forgetBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${scope.botId} FOR UPDATE`;
    await tx.botSecret.deleteMany({ where: { ...scopeFields(scope), name } });
  });
  return { removed: true };
}

/** Credentials are resolved only inside this destination-bound HTTP boundary. */
export async function requestWithBotSecret(input: {
  prisma: PrismaClient;
  secretStore: EncryptedSecretStore;
  scope: BotSecretScope;
  request: unknown;
  signal: AbortSignal;
  remote?: RemoteTransportDependencies;
  registerRedactions?: (values: string[]) => void;
}): Promise<unknown> {
  const request = SecretHttpRequest.parse(input.request);
  const row = await input.prisma.botSecret.findFirst({
    where: { ...scopeFields(input.scope), name: request.name },
  });
  if (!row) return { error: "Credential is unavailable. Use request_secret to save it first." };
  const destination = normalizeSecretDestination(row);
  if (destination.auth.type === "login") {
    return { error: "Website logins can only be filled into their site with browser_act." };
  }
  const url = new URL(request.url);
  if (url.origin !== destination.origin || url.username || url.password || url.hash) {
    return { error: "This credential cannot be sent to that destination." };
  }
  const plaintext = input.secretStore.load(row.ciphertext, row.id);
  const headers = new Headers({ accept: "application/json", "content-type": request.contentType });
  const { name: headerName, value: headerValue } = credentialHeader(destination, plaintext);
  const redactions = [
    ...new Set([
      plaintext,
      headerValue,
      Buffer.from(plaintext).toString("base64"),
      encodeURIComponent(plaintext),
      headerValue.replace(/^Basic /, ""),
    ]),
  ].filter(Boolean);
  input.registerRedactions?.(redactions);
  const controller = new AbortController();
  const signal = combineSignals(input.signal, controller.signal, AbortSignal.timeout(30_000));
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
  const fetch = privateHttpDestination
    ? createPrivateNetworkFetch(input.remote?.fetch, input.remote?.resolveHostname)
    : createSafeRemoteFetch(input.remote?.fetch, input.remote?.resolveHostname);
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
    return {
      status: response.status,
      body: safe.length > 20_000 ? safe.slice(0, 20_000) : JSON.parse(safe),
      truncated: safe.length > 20_000,
    };
  } catch {
    return { error: "Authenticated request failed. Check the destination and credential." };
  } finally {
    controller.abort();
    await withAbort(fetch.close(), AbortSignal.timeout(1000)).catch(() => undefined);
  }
}

export type LoginField = "username" | "password";
const MIN_REDACTED_USERNAME = 6;

/**
 * Resolve one field of a saved website login for a page fill. The caller must pass `origin` to
 * the page browser, which refuses to fill unless the page is still on that origin.
 */
export async function resolveLoginFill(input: {
  prisma: PrismaClient;
  secretStore: EncryptedSecretStore;
  scope: BotSecretScope;
  name: string;
  field: LoginField;
}): Promise<{ text: string; origin: string; redactions: string[] } | { error: string }> {
  const row = await input.prisma.botSecret.findFirst({
    where: { ...scopeFields(input.scope), name: input.name },
  });
  if (!row) return { error: "Login is unavailable. Use request_secret to save it first." };
  // Checked on the stored origin itself, so the private-LAN HTTP allowance cannot widen a login.
  let storedOrigin: URL;
  try {
    storedOrigin = new URL(row.origin);
  } catch {
    return { error: "Website logins can only be filled on an HTTPS origin." };
  }
  if (storedOrigin.protocol !== "https:") {
    return { error: "Website logins can only be filled on an HTTPS origin." };
  }
  const destination = normalizeSecretDestination(row);
  if (destination.auth.type !== "login") {
    return { error: "This credential is not a website login." };
  }
  if (destination.origin !== storedOrigin.origin) {
    return { error: "Website logins can only be filled on an HTTPS origin." };
  }
  const login = decodeLoginSecret(input.secretStore.load(row.ciphertext, row.id));
  return {
    text: login[input.field],
    origin: destination.origin,
    // Redaction is substring replacement, so a short username would mangle unrelated text.
    redactions: [
      ...new Set(
        [login.password, encodeURIComponent(login.password)].concat(
          login.username.length >= MIN_REDACTED_USERNAME
            ? [login.username, encodeURIComponent(login.username)]
            : [],
        ),
      ),
    ],
  };
}
