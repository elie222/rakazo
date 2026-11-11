import { randomBytes } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type {
  BotSecretDestination,
  CardSecretValue,
  LoginField,
  LoginSecretValue,
  PurchaseCardField,
  SettingsScope,
  VaultPreview,
} from "@rakazo/contracts";
import {
  BotSecretAuth,
  BotSecretName,
  botSecretDestinationSchema,
  cardExpiry,
  cardSummary,
  cardTitle,
  commandVariableName,
  commandVariableProblem,
  DEFAULT_LOGIN_FIELD_LABELS,
  decodeCardSecret,
  decodeContactSecret,
  decodeLoginSecret,
  encodeCardSecret,
  encodeContactSecret,
  encodeLoginSecret,
  GeneratedSecretRules,
  GenerateSecretInput,
  isPrivateNetworkHost,
  isSitelessAuth,
  LOGIN_FIELD_LIMIT,
  LoginFieldLabels,
  loginCommandName,
  ONE_TIME_CODE_MIN_LENGTH,
  OneTimeCodeTarget,
  SecretHttpRequest,
  sameLoginFieldLabel,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  ContentDecryptionError,
  ciphertextKeyId,
  lockSpaceSettings,
  runCodeKind,
  runCodeSpentKind,
  runLoginKind,
  settingsTarget,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { combineSignals, redactConnectorPayload } from "./connector-safety.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { createPrivateNetworkFetch, createSafeRemoteFetch } from "./remote-mcp.js";
import { generateSecretValue } from "./secret-generator.js";
import { persistPreparedSecret } from "./secret-persistence.js";
import { openVaultValue, sealVaultValue } from "./vault-values.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

/**
 * The member a credential call acts for, in one Space. `vault` picks the account's vault or the
 * Space's own; omitted, it is whichever this Space uses, which is what bots read and write.
 */
export type BotSecretScope = { userId: string; spaceId: string; vault?: SettingsScope };
type VaultClient = Pick<PrismaClient, "spaceSettingOverride">;

/**
 * Orders a vault write after any change of vault (the member's settings lock) and after every
 * other write by the member, since Spaces without their own vault share the account's.
 */
async function lockVault(tx: Pick<Prisma.TransactionClient, "$queryRaw">, scope: BotSecretScope) {
  await lockSpaceSettings(tx, scope);
  await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${scope.userId} FOR UPDATE`;
}

export const SPACE_VAULT_NOT_IN_USE = "This Space uses the account vault";

/**
 * A write aimed at a Space's own vault is refused once the Space stops customizing credentials,
 * since nothing would read it and it would only wait to be deleted.
 */
async function assertVaultInUse(client: VaultClient, scope: BotSecretScope) {
  if (scope.vault !== "space") return;
  if ((await settingsTarget(client, scope, "credentials")) !== "space") {
    throw new Error(SPACE_VAULT_NOT_IN_USE);
  }
}

/** The vault rows a call reads and writes: the account's (no Space) or the Space's own. */
async function vaultFields(client: VaultClient, scope: BotSecretScope) {
  const target = await settingsTarget(client, scope, "credentials", scope.vault);
  return { userId: scope.userId, spaceId: target === "space" ? scope.spaceId : null };
}

const metadata = { name: true, origin: true, auth: true } as const;
// What people see of an item besides its destination.
const labels = { title: true, note: true } as const;
// What reading an item's value needs: the vault it is in is part of its encryption.
const vaultRow = { id: true, userId: true, spaceId: true, ciphertext: true } as const;

const SECRET_ALREADY_SAVED = "A credential with this name is already saved";

/** A create-only save found the name taken, by an earlier save or a concurrent one. */
export function isSecretAlreadySaved(error: unknown): boolean {
  return error instanceof Error && error.message === SECRET_ALREADY_SAVED;
}
const UNUSABLE_CREDENTIAL = "Credential cannot be used with this authentication method";

/** `encodeURIComponent` throws on an unpaired surrogate. */
function percentEncoded(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function commandRedactionForms(value: string): string[] {
  const forms = [value, Buffer.from(value).toString("base64")];
  const encoded = percentEncoded(value);
  if (encoded !== undefined) forms.push(encoded);
  return forms;
}

export function commandCredentialRedactions(environment: Record<string, string>): string[] {
  return [...new Set(Object.values(environment).flatMap(commandRedactionForms))];
}

function credentialHeader(destination: BotSecretDestination, plaintext: string) {
  // A login is only typed into its site, a command variable only reaches shell commands, and a
  // card or contact is only typed into pages.
  if (
    destination.auth.type !== "bearer" &&
    destination.auth.type !== "header" &&
    destination.auth.type !== "basic"
  ) {
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
  if (isSitelessAuth(parsed.data.auth.type)) return parsed.data;
  return { ...parsed.data, origin: new URL(parsed.data.origin).origin };
}

function isCommandCredential(auth: unknown): boolean {
  const parsed = BotSecretAuth.safeParse(auth);
  return parsed.success && parsed.data.type === "command";
}

/**
 * What the bot's tools show for a saved credential. A command variable has no site, so it is
 * listed with the environment variable its shell commands read instead.
 */
export function botSecretToolView(row: { name: string; origin: string; auth: unknown }) {
  if (!isCommandCredential(row.auth)) return row;
  const variable = commandVariableName(row.name);
  const problem = commandVariableProblem(variable);
  if (problem === undefined) return { name: row.name, auth: row.auth, variable };
  const reason =
    problem === "reserved"
      ? `$${variable} is reserved and is not exported.`
      : `$${variable} is not a valid environment variable name and is not exported.`;
  return {
    name: row.name,
    auth: row.auth,
    error: `${reason} Remove it and save it under another name.`,
  };
}

/**
 * Decrypt this bot's command variables for one shell command. Loaded per command so an added,
 * replaced, or removed value applies to the next command. The values must never be logged or
 * returned; callers register them for redaction before the command runs. A value whose vault key
 * the key manager can't provide throws, so a run or check doesn't start without hiding it, unless
 * `keyOutage` is "unset": a running run already hides the values it loaded when it started.
 */
export async function loadBotCommandEnvironment(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  unsetVariables?: Set<string>,
  keyOutage: "throw" | "unset" = "throw",
): Promise<Record<string, string>> {
  const rows = await prisma.vaultCredential.findMany({
    where: await vaultFields(prisma, scope),
    select: { ...vaultRow, name: true, auth: true },
    orderBy: { name: "asc" },
  });
  const environment: Record<string, string> = {};
  for (const row of rows) {
    if (!isCommandCredential(row.auth)) continue;
    const variable = commandVariableName(row.name);
    if (commandVariableProblem(variable)) continue;
    let value: string;
    try {
      value = await openForRedaction(prisma, secretStore, row);
    } catch (error) {
      if (error instanceof VaultKeyUnavailableError && keyOutage === "throw") throw error;
      // One unreadable value must not stop every shell command; the variable is left unset.
      unsetVariables?.add(variable);
      continue;
    }
    if (value && !value.includes("\0")) environment[variable] = value;
  }
  return environment;
}

/**
 * The environment for one shell command: the command variables of the vault this Space uses,
 * loaded fresh. The values are handed to `registerRedactions` before this returns, so the
 * command's output is redacted.
 */
export async function shellCommandEnvironment(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  scope: BotSecretScope;
  registerRedactions: (values: string[]) => void;
  keyOutage?: "throw" | "unset";
}): Promise<{ env: Record<string, string>; unsetEnv: string[] }> {
  const unsetVariables = new Set<string>();
  const botEnvironment = await loadBotCommandEnvironment(
    input.prisma,
    input.secretStore,
    input.scope,
    unsetVariables,
    input.keyOutage,
  );
  // Encoded forms too, as secret_request does, so an accidental `base64` or URL-encoding of a
  // value is still redacted from command output.
  input.registerRedactions(commandCredentialRedactions(botEnvironment));
  return { env: botEnvironment, unsetEnv: [...unsetVariables] };
}

/** Another command credential of this bot that is exported as the same variable. */
export async function findCommandVariableConflict(
  client: PrismaClient | Prisma.TransactionClient,
  scope: BotSecretScope,
  destination: BotSecretDestination,
): Promise<string | undefined> {
  if (destination.auth.type !== "command") return undefined;
  const variable = commandVariableName(destination.name);
  const rows = await client.vaultCredential.findMany({
    where: { ...(await vaultFields(client, scope)), name: { not: destination.name } },
    select: { name: true, auth: true },
  });
  return rows.find(
    (row) => isCommandCredential(row.auth) && commandVariableName(row.name) === variable,
  )?.name;
}

/** The bot must tell the user why it falls back to a takeover, so the refusal says so. */
const NOT_HTTPS_CODE =
  "Codes can only be typed on HTTPS pages, and this page isn't HTTPS. Ask the user to take over and tell them that is why.";

export type RequestSecretDestinationResult = {
  /** Metadata only. The protected value is never part of this result. */
  destination?: BotSecretDestination;
  connectionId?: string;
  /** The HTTPS origin a texted or emailed code is for. */
  oneTimeCodeOrigin?: string;
  error?: string;
};

/**
 * The model-facing schema is one object, so a credential often arrives beside
 * `connectionId`, as a JSON string, or as top-level `name` / `origin` / `auth`
 * instead of a nested `credential`. A destination that normalizes is the masked
 * reusable path. `connectionId` applies only when no credential was supplied.
 */
export function resolveRequestSecretDestination(
  args: Record<string, unknown>,
): RequestSecretDestinationResult {
  const credential = credentialArgument(args);
  if (credential !== undefined) {
    try {
      return { destination: normalizeSecretDestination(credential) };
    } catch (error) {
      return {
        error:
          error instanceof Error && error.message.startsWith("Invalid credential destination")
            ? error.message
            : "Specify a credential name, HTTPS origin, and auth method.",
      };
    }
  }
  const connectionId = connectionIdArgument(args.connectionId);
  if (connectionId) return { connectionId };
  if (args.oneTimeCode !== undefined) {
    const target = OneTimeCodeTarget.safeParse(args.oneTimeCode);
    if (target.success) return { oneTimeCodeOrigin: target.data.origin };
    const origin = isPlainObject(args.oneTimeCode) ? args.oneTimeCode.origin : undefined;
    return {
      error:
        typeof origin === "string" && URL.canParse(origin) && new URL(origin).protocol === "http:"
          ? NOT_HTTPS_CODE
          : "oneTimeCode needs the HTTPS origin of the page that asked for the code.",
    };
  }
  return {
    error:
      "Provide either a reusable credential destination, a connectionId, or oneTimeCode for a code the page asked for.",
  };
}

/** `{ origin }` only, reduced to the site: a code is never tied to a path, query or userinfo. */
export function oneTimeCodeArgument(value: unknown): unknown {
  if (!isPlainObject(value)) return value === undefined ? undefined : {};
  return { origin: originMetadata(value.origin) ?? "invalid-origin" };
}

/** Labels only, also from `{ label, hidden }` objects, so a bot's `hidden` is never recorded. */
export function loginFieldLabelsArgument(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((field) => (isPlainObject(field) ? field.label : field))
    : value;
}

/**
 * The field labels a login card asks for. Only labels: the card derives each field's starting
 * state from its label, the person has the last word, and anything else the bot sends with a
 * field is dropped.
 */
export function requestedLoginFields(value: unknown): { labels?: string[]; error?: string } {
  if (value === undefined || value === null) return {};
  const parsed = LoginFieldLabels.safeParse(loginFieldLabelsArgument(value));
  if (parsed.success) return { labels: parsed.data };
  return {
    error: `fields must list 1 to ${LOGIN_FIELD_LIMIT} different labels of at most 64 characters, such as ["Email", "Password"].`,
  };
}

const destinationFields = ["name", "origin", "auth"] as const;

/**
 * Credential object from `credential`, a JSON string of that object, or top-level fields.
 * Only destination metadata is returned. A partial `name` / `origin` / `auth` set is still
 * a credential attempt so it cannot fall through to `connectionId`.
 */
export function credentialArgument(args: Record<string, unknown>): unknown {
  if (Object.hasOwn(args, "credential") && args.credential != null && args.credential !== "") {
    return parsedCredentialObject(args.credential);
  }
  if (destinationFields.some((key) => Object.hasOwn(args, key))) {
    return destinationMetadata(args);
  }
  return undefined;
}

export function connectionIdArgument(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return undefined;
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * `{ name, origin, auth }` only. Secret fields must not survive, including ones nested in
 * `auth` or carried in an origin string. The effect request is this object, and destination
 * parsing strips extras only from its own copy.
 */
function destinationMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of destinationFields) {
    if (!Object.hasOwn(record, key)) continue;
    if (key === "auth") {
      const auth = authMetadata(record.auth);
      if (auth !== undefined) metadata.auth = auth;
      continue;
    }
    if (key === "origin") {
      const origin = originMetadata(record.origin);
      if (origin !== undefined) metadata.origin = origin;
      continue;
    }
    if (typeof record.name === "string") {
      // Keep a real name. Anything else is replaced so a secret in that string is not recorded,
      // while destination validation still reports the name pattern.
      metadata.name = BotSecretName.safeParse(record.name).success ? record.name : "Invalid Name";
    }
  }
  return metadata;
}

/**
 * Parsed auth, or a stand-in that fails the same way. The stand-in does not copy the
 * original fields: an invalid method or header can still carry a secret, and the effect
 * row is written before destination validation.
 */
function authMetadata(value: unknown): unknown {
  const parsed = BotSecretAuth.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!isPlainObject(value)) return undefined;
  if (value.type === "header") {
    if (typeof value.name !== "string") return { type: "header" };
    const header = BotSecretAuth.safeParse({ type: "header", name: value.name });
    const unsupported =
      !header.success &&
      header.error.issues.some((issue) => issue.message === "Unsupported credential header");
    return { type: "header", name: unsupported ? "Cookie" : "bad header" };
  }
  if (value.type === "basic") {
    if (typeof value.username !== "string") return { type: "basic" };
    return { type: "basic", username: ":" };
  }
  return { type: "invalid" };
}

/**
 * The site a credential is saved under when given a page URL: the origin of an http or https
 * URL, without its path, query or fragment. Any other scheme gets nothing, since
 * `blob:https://host/x` reports `https://host` without being a page on it. With
 * `allowUserinfo` false, a URL carrying a username or password gets nothing either, and so does
 * one longer than `maxLength`, checked on what was given rather than on the site it reduces to.
 */
export function pageUrlOrigin(
  value: string,
  { allowUserinfo, maxLength }: { allowUserinfo: boolean; maxLength: number },
): string | undefined {
  if (value.length > maxLength) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!allowUserinfo && (url.username || url.password)) return undefined;
  return url.origin;
}

/**
 * Keep only the site. Never return the raw string: `new URL` resolves `..`, so the raw
 * path can still hold a secret while the parsed path is `/`. Userinfo, query, fragment,
 * and path are removed. A placeholder keeps the origin error when no site remains.
 */
function originMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "") return "";
  // A sign-in redirect URL can be long; the authenticated request URL's limit, not the origin's.
  return pageUrlOrigin(value, { allowUserinfo: true, maxLength: 8192 }) ?? "invalid-origin";
}

function parsedCredentialObject(value: unknown): unknown {
  if (typeof value !== "string") {
    // Not metadata. Keep the attempt, but do not forward the raw value into the effect.
    return isPlainObject(value) ? destinationMetadata(value) : {};
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isPlainObject(parsed)) return destinationMetadata(parsed);
  } catch {
    return {};
  }
  return {};
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

/** Only an HTTPS login moves to another site; nothing else about it changes. */
export function canReplaceLoginSite(
  saved: BotSecretDestination,
  destination: BotSecretDestination,
): boolean {
  return (
    saved.auth.type === "login" &&
    destination.origin.startsWith("https://") &&
    sameSecretDestination({ ...saved, origin: destination.origin }, destination)
  );
}

/** The credential saved under `name`. Its row id is for a card that replaces it, never for the bot. */
export async function findBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  const row = await prisma.vaultCredential.findFirst({
    where: { ...(await vaultFields(prisma, scope)), name },
    select: { ...metadata, id: true },
  });
  return row ? { id: row.id, destination: normalizeSecretDestination(row) } : null;
}

/**
 * The one login saved for exactly this HTTPS site, whatever its name. Bots name logins themselves,
 * so a later request under another name for the same site still finds it. None when two are saved.
 */
export async function findSiteLogin(prisma: PrismaClient, scope: BotSecretScope, origin: string) {
  if (!origin.startsWith("https://")) return null;
  const rows = await prisma.vaultCredential.findMany({
    where: { ...(await vaultFields(prisma, scope)), origin },
    select: metadata,
  });
  // A row saved before today's name or site rules can't be filled, so it doesn't count.
  const logins = rows.flatMap((row) => {
    try {
      const login = normalizeSecretDestination(row);
      return login.auth.type === "login" ? [login] : [];
    } catch {
      return [];
    }
  });
  return logins.length === 1 ? logins[0] : null;
}

/**
 * The value as it is saved: a login, card or contact in its current shape, so every reader gets
 * one form. Throws when the value is not one of its kind.
 */
export function canonicalSecretValue(destination: BotSecretDestination, plaintext: string): string {
  // Saved in its current shape, also when an older app sends a username and password.
  if (destination.auth.type === "login") return encodeLoginSecret(decodeLoginSecret(plaintext));
  try {
    if (destination.auth.type === "card") return encodeCardSecret(JSON.parse(plaintext));
    if (destination.auth.type === "contact") return encodeContactSecret(JSON.parse(plaintext));
  } catch {
    // The parse error may quote the value, so only the kind is named.
    throw new Error(`Invalid ${destination.auth.type}`);
  }
  return plaintext;
}

export async function prepareBotSecret(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  destination: BotSecretDestination;
  plaintext: string;
  /** Refuse instead of replacing a credential saved under this name, even by a concurrent call. */
  createOnly?: boolean;
  /**
   * The id of the saved login of this name that this login replaces, from a login card the person
   * answered for another site. Without it, a credential's destination never changes.
   */
  replaces?: string;
  /** What people call the item and when to use it; left as they are when omitted. */
  title?: string;
  note?: string;
}) {
  const { prisma, secretStore, scope } = input;
  let { plaintext } = input;
  if (!plaintext || plaintext.length > 16_384) throw new Error("Invalid credential length");
  const destination = normalizeSecretDestination(input.destination);
  if (
    destination.auth.type === "login" ||
    destination.auth.type === "card" ||
    destination.auth.type === "contact"
  ) {
    plaintext = canonicalSecretValue(destination, plaintext);
  } else if (destination.auth.type === "command") {
    // NUL cannot be an environment value. An unpaired surrogate cannot be percent-encoded
    // later, and that throw would abort every subsequent shell command for this bot.
    if (plaintext.includes("\0") || percentEncoded(plaintext) === undefined) {
      throw new Error(UNUSABLE_CREDENTIAL);
    }
  } else credentialHeader(destination, plaintext);
  await assertVaultInUse(prisma, scope);
  const vault = await vaultFields(prisma, scope);
  const existing = await prisma.vaultCredential.findFirst({
    where: { ...vault, name: destination.name },
  });
  function validate(row: typeof existing, count: number) {
    if (row && input.createOnly) throw new Error(SECRET_ALREADY_SAVED);
    const saved = row && normalizeSecretDestination(row);
    if (
      saved &&
      !sameSecretDestination(saved, destination) &&
      !(row?.id === input.replaces && canReplaceLoginSite(saved, destination))
    )
      throw new Error("Remove the existing credential before changing its destination");
    if (!row && count >= 100) throw new Error("Credential limit reached");
  }
  validate(existing, await prisma.vaultCredential.count({ where: vault }));
  const id = existing?.id ?? randomBytes(12).toString("hex");
  const ciphertext = await sealVaultValue(prisma, secretStore, { id, ...vault }, plaintext, {
    operationId: id,
    traceId: id,
    userId: scope.userId,
    spaceId: scope.spaceId,
    signal: new AbortController().signal,
  });
  return {
    id,
    ciphertext,
    async store(tx: Prisma.TransactionClient) {
      await lockVault(tx, scope);
      // `migrate` and `decrypt` take no vault lock, so the item itself is locked before it is read.
      if (existing)
        await tx.$queryRaw`SELECT id FROM vault_credentials WHERE id = ${existing.id} FOR UPDATE`;
      await assertVaultInUse(tx, scope);
      const current = await tx.vaultCredential.findFirst({
        where: { ...vault, name: destination.name },
      });
      if (JSON.stringify(await vaultFields(tx, scope)) !== JSON.stringify(vault)) {
        throw Object.assign(new Error("Vault changed while saving; retry"), { code: "P2034" });
      }
      validate(current, await tx.vaultCredential.count({ where: vault }));
      const conflict = await findCommandVariableConflict(tx, scope, destination);
      if (conflict) {
        throw new Error(
          `Invalid credential destination — name: ${conflict} is already exported as $${commandVariableName(destination.name)}`,
        );
      }
      // A vault command moving the item since it was read changes which format or key to seal.
      if (
        current?.id !== existing?.id ||
        (current && ciphertextKeyId(current.ciphertext) !== ciphertextKeyId(existing!.ciphertext))
      )
        throw Object.assign(new Error("Credential changed while saving; retry"), { code: "P2034" });
      const labelled = {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      };
      // The site and the value change together; validate allowed another site only when replacing.
      if (current)
        await tx.vaultCredential.update({
          where: { id },
          data: { origin: destination.origin, ciphertext, ...labelled },
        });
      else
        await tx.vaultCredential.create({
          data: { id, ...vault, ...destination, ...labelled, ciphertext },
        });
    },
  };
}

export async function storeBotSecret(input: Parameters<typeof prepareBotSecret>[0]) {
  return withTransactionRetry(async () => {
    const prepared = await prepareBotSecret(input);
    return persistPreparedSecret(input.prisma, input.secretStore, prepared, () =>
      input.prisma.$transaction(async (tx) => {
        await prepared.store(tx);
        return getBotSecretMetadata(tx, input.scope, input.destination.name);
      }),
    );
  });
}

/** Save a generated login and the command variable holding its password together, or neither. */
async function storeLoginWithCommand(
  login: Parameters<typeof prepareBotSecret>[0],
  command: Parameters<typeof prepareBotSecret>[0],
) {
  const { prisma, secretStore } = login;
  await withTransactionRetry(async () => {
    const preparedLogin = await prepareBotSecret(login);
    // Prepared inside, so a refused command variable still cleans up the login's stored value.
    await persistPreparedSecret(prisma, secretStore, preparedLogin, async () => {
      const preparedCommand = await prepareBotSecret(command);
      await persistPreparedSecret(prisma, secretStore, preparedCommand, () =>
        prisma.$transaction(async (tx) => {
          await preparedLogin.store(tx);
          await preparedCommand.store(tx);
        }),
      );
    });
  });
}

/**
 * Generate a random value and save it as a new login (with its username, for one site) or a
 * command variable. A login can also save its password as a command variable, for a CLI. Only its redaction forms are returned, for the run to hide; the model sees
 * the saved name, never the value. An existing credential is never overwritten: a site or
 * service may already use its value.
 */
export async function generateBotSecret(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  args: unknown;
}): Promise<{ result: Record<string, unknown>; redactions?: string[] }> {
  const parsed = GenerateSecretInput.safeParse(input.args);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    return { result: { error: `Invalid secret — ${detail}` } };
  }
  const { name, type, origin, username } = parsed.data;
  // The same normalization as request_secret, so a sign-up page URL saves its origin.
  const { destination, error } = resolveRequestSecretDestination({
    credential: { name, origin, auth: { type } },
  });
  if (!destination) return { result: { error } };
  const command: BotSecretDestination | undefined = parsed.data.command
    ? { name: loginCommandName(name), origin: "", auth: { type: "command" } }
    : undefined;
  const existing = (await findBotSecret(input.prisma, input.scope, name))?.destination;
  if (existing) {
    return {
      result: sameSecretDestination(existing, destination)
        ? {
            error:
              type === "login"
                ? "A login with this name is already saved for this site; fill it with browser_act fill_secret. Use another name for a different account."
                : "A command variable with this name is already saved; use it as it is, or use another name.",
            ...botSecretToolView(existing),
          }
        : { error: "A credential with this name already exists. Use another name." },
    };
  }
  if (command && (await findBotSecret(input.prisma, input.scope, command.name))) {
    return {
      result: {
        error: `A credential named ${command.name} already exists. Use another name for the login.`,
      },
    };
  }
  const value = generateSecretValue(parsed.data.rules ?? GeneratedSecretRules.parse({}));
  const save = {
    prisma: input.prisma,
    secretStore: input.secretStore,
    scope: input.scope,
    createOnly: true,
  };
  const [usernameLabel, passwordLabel] = DEFAULT_LOGIN_FIELD_LABELS;
  const plaintext = username
    ? encodeLoginSecret({
        fields: [
          { label: usernameLabel, value: username, hidden: false },
          { label: passwordLabel, value, hidden: true },
        ],
      })
    : value;
  try {
    if (command) {
      await storeLoginWithCommand(
        { ...save, destination, plaintext },
        { ...save, destination: command, plaintext: value },
      );
    } else await storeBotSecret({ ...save, destination, plaintext });
    return {
      result: {
        saved: true,
        ...botSecretToolView(destination),
        ...(command ? { command: botSecretToolView(command) } : {}),
      },
      redactions: passwordRedactionForms(value),
    };
  } catch (error) {
    return { result: { error: error instanceof Error ? error.message : "Secret was not saved." } };
  }
}

/**
 * What list_secrets shows. A contact is shown in full, since the bot types it into forms; a card
 * only as its brand, last four digits, expiry and name, never its number or security code.
 */
export async function listBotSecrets(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
) {
  const rows = await prisma.vaultCredential.findMany({
    where: await vaultFields(prisma, scope),
    select: { ...metadata, ...labels, ...vaultRow },
    orderBy: { name: "asc" },
  });
  return Promise.all(
    rows.map(async ({ id, userId, spaceId, ciphertext, title, note, ...row }) => {
      const preview = await itemPreview(prisma, secretStore, {
        id,
        userId,
        spaceId,
        ciphertext,
        auth: row.auth,
      });
      const view = botSecretToolView({ name: row.name, origin: row.origin, auth: row.auth });
      return {
        ...view,
        ...(title ? { title } : {}),
        ...(note ? { note } : {}),
        ...(preview?.card
          ? { card: { ...preview.card, expiry: cardExpiry(preview.card) } }
          : preview?.contact
            ? { contact: preview.contact }
            : {}),
      };
    }),
  );
}

// Owner-facing view: destination, labels and timestamps only, never the row id or ciphertext.
const ownerMetadata = { ...metadata, ...labels, createdAt: true, updatedAt: true } as const;

export async function listBotSecretMetadata(prisma: PrismaClient, scope: BotSecretScope) {
  return prisma.vaultCredential.findMany({
    where: await vaultFields(prisma, scope),
    select: ownerMetadata,
    orderBy: { name: "asc" },
  });
}

/**
 * What a list shows of an item's saved value: a login's first visible field, a card's summary, or
 * a contact. Nothing for other kinds, whose value is the secret itself, or a value that can't be read.
 */
async function itemPreview(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  row: Parameters<typeof openVaultValue>[2] & { auth: unknown },
): Promise<VaultPreview | undefined> {
  const type = BotSecretAuth.safeParse(row.auth).data?.type;
  if (type !== "login" && type !== "card" && type !== "contact") return undefined;
  try {
    const plaintext = await openVaultValue(prisma, secretStore, row);
    if (type === "card") return { card: cardSummary(decodeCardSecret(plaintext)) };
    if (type === "contact") return { contact: decodeContactSecret(plaintext) };
    const username = decodeLoginSecret(plaintext).fields.find((field) => !field.hidden)?.value;
    return username ? { username } : {};
  } catch {
    getLogger().warn("vault item could not be read for its preview", { itemId: row.id });
    return undefined;
  }
}

/** The title an item shows: the one its owner gave, or one read from the item itself. */
export function vaultItemTitle(
  row: { name: string; origin: string; title: string },
  preview: VaultPreview | undefined,
): string {
  if (row.title) return row.title;
  if (preview?.card) return cardTitle(preview.card);
  if (preview?.contact?.name) return preview.contact.name;
  if (URL.canParse(row.origin)) return new URL(row.origin).host.replace(/^www\./, "");
  return row.name;
}

/** The title a new item shows when its owner gives none, read from the value being saved. */
export function defaultVaultItemTitle(
  destination: { origin: string; auth: { type: string } },
  plaintext: string,
): string {
  const parsed = BotSecretAuth.safeParse(destination.auth);
  if (!parsed.success) return "";
  const value = canonicalSecretValue(
    { name: "item", origin: destination.origin, auth: parsed.data },
    plaintext,
  );
  const preview =
    parsed.data.type === "card"
      ? { card: cardSummary(decodeCardSecret(value)) }
      : parsed.data.type === "contact"
        ? { contact: decodeContactSecret(value) }
        : undefined;
  return vaultItemTitle({ name: "", title: "", origin: destination.origin }, preview);
}

/** The owner's list, or one item by name: titles and previews, never a protected value. */
export async function listVaultItems(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  name?: string,
) {
  const rows = await prisma.vaultCredential.findMany({
    where: { ...(await vaultFields(prisma, scope)), ...(name !== undefined ? { name } : {}) },
    select: { ...ownerMetadata, ...vaultRow },
    orderBy: { name: "asc" },
  });
  return Promise.all(
    rows.map(async ({ id, userId, spaceId, ciphertext, ...row }) => {
      const preview = await itemPreview(prisma, secretStore, {
        id,
        userId,
        spaceId,
        ciphertext,
        auth: row.auth,
      });
      return { ...row, title: vaultItemTitle(row, preview), preview };
    }),
  );
}

/**
 * A free handle for a new item, from its title: "Home" becomes home, a second "Home" home-2. A title
 * with no letters to use falls back to the item's kind.
 */
export async function newVaultItemName(
  prisma: PrismaClient,
  scope: BotSecretScope,
  base: string,
  kind: string,
): Promise<string> {
  const slug = base
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 56);
  const stem = slug || kind;
  const taken = new Set(
    (
      await prisma.vaultCredential.findMany({
        where: { ...(await vaultFields(prisma, scope)), name: { startsWith: stem } },
        select: { name: true },
      })
    ).map((row) => row.name),
  );
  if (!taken.has(stem)) return stem;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${stem}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Change only what people call an item and when to use it. */
export async function relabelVaultItem(
  prisma: PrismaClient,
  scope: BotSecretScope,
  name: string,
  labels: { title?: string; note?: string },
) {
  await assertVaultInUse(prisma, scope);
  // Only these columns: the rest of a request never reaches the row.
  const data = {
    ...(labels.title !== undefined ? { title: labels.title } : {}),
    ...(labels.note !== undefined ? { note: labels.note } : {}),
  };
  const updated = await prisma.vaultCredential.updateMany({
    where: { ...(await vaultFields(prisma, scope)), name },
    data,
  });
  return updated.count > 0;
}

export async function getBotSecretMetadata(
  client: PrismaClient | Prisma.TransactionClient,
  scope: BotSecretScope,
  name: string,
) {
  return client.vaultCredential.findFirst({
    where: { ...(await vaultFields(client, scope)), name },
    select: ownerMetadata,
  });
}

/**
 * A saved value for its owner to read. Only for the owner-facing reveal, which confirms the
 * person first; bots never read values. A login returns its fields.
 */
export async function revealBotSecret(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  scope: BotSecretScope;
  name: string;
}): Promise<LoginSecretValue | { card: CardSecretValue } | { value: string } | null> {
  const row = await input.prisma.vaultCredential.findFirst({
    where: { ...(await vaultFields(input.prisma, input.scope)), name: input.name },
  });
  if (!row) return null;
  const plaintext = await openVaultValue(input.prisma, input.secretStore, row);
  const type = BotSecretAuth.safeParse(row.auth).data?.type;
  if (type === "login") return decodeLoginSecret(plaintext);
  if (type === "card") return { card: decodeCardSecret(plaintext) };
  return { value: plaintext };
}

export async function forgetBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  await prisma.$transaction(async (tx) => {
    await lockVault(tx, scope);
    await tx.vaultCredential.deleteMany({ where: { ...(await vaultFields(tx, scope)), name } });
  });
  return { removed: true };
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
}): Promise<unknown> {
  const request = SecretHttpRequest.parse(input.request);
  const row = await input.prisma.vaultCredential.findFirst({
    where: { ...(await vaultFields(input.prisma, input.scope)), name: request.name },
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

// Redaction is substring replacement, so a short visible value would mangle unrelated text.
const MIN_REDACTED_VISIBLE_VALUE = 6;
const MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN = MIN_REDACTED_VISIBLE_VALUE;

function passwordRedactionForms(password: string): string[] {
  return [
    ...new Set([
      ...commandRedactionForms(password),
      // A submitted form encodes `+` for spaces and escapes `!'()~`, unlike encodeURIComponent.
      new URLSearchParams({ v: password }).toString().slice(2),
    ]),
  ];
}

/** A card number as pages show it: as given, digits only, and in groups of four. */
export function cardRedactionForms(number: string): string[] {
  const digits = number.replace(/\D/g, "");
  const grouped = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
  const hyphenated = digits.replace(/(\d{4})(?=\d)/g, "$1-");
  return [...new Set([number, digits, grouped, hyphenated].filter(Boolean))];
}

export class VaultKeyUnavailableError extends Error {
  constructor(cause: unknown) {
    super("A vault key could not be loaded from the key manager", { cause });
    this.name = "VaultKeyUnavailableError";
  }
}

/**
 * A value to hide in every run. When the key manager can't provide its vault's key, the run must
 * not start without hiding it, as content reads fail then too; an item whose own stored data
 * doesn't open is skipped like any other unreadable item.
 */
async function openForRedaction(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  row: Parameters<typeof openVaultValue>[2],
): Promise<string> {
  try {
    return await openVaultValue(prisma, secretStore, row);
  } catch (error) {
    if (ciphertextKeyId(row.ciphertext) !== undefined && !(error instanceof ContentDecryptionError))
      throw new VaultKeyUnavailableError(error);
    throw error;
  }
}

/**
 * Redaction forms of the hidden fields of every website login saved for this bot, and of every
 * saved card's number. A filled login or card stays on its page after the run that filled it, so
 * each run hides them before any tool output reaches the model. Visible fields stay readable
 * outside the filling run: one is often the user's own email, which ordinary tasks need. Only
 * login and card rows are decrypted.
 */
export async function loadLoginPasswordRedactions(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
): Promise<string[]> {
  // Every saved login and card, however many other credentials the bot has; only they are read.
  const rows = await prisma.vaultCredential.findMany({
    where: {
      ...(await vaultFields(prisma, scope)),
      OR: [
        { auth: { path: ["type"], equals: "login" } },
        { auth: { path: ["type"], equals: "card" } },
      ],
    },
    select: { ...vaultRow, auth: true },
  });
  const forms = new Set<string>();
  for (const row of rows) {
    const type = BotSecretAuth.safeParse(row.auth).data?.type;
    if (type === "card") {
      try {
        const card = decodeCardSecret(await openForRedaction(prisma, secretStore, row));
        for (const form of cardRedactionForms(card.number)) forms.add(form);
      } catch (error) {
        if (error instanceof VaultKeyUnavailableError) throw error;
        getLogger().warn("saved card could not be loaded for redaction", { cardId: row.id });
      }
      continue;
    }
    if (type !== "login") continue;
    try {
      const { fields } = decodeLoginSecret(await openForRedaction(prisma, secretStore, row));
      for (const field of fields) {
        // Every run would mangle each occurrence of a short value; the filling run still hides it.
        if (!field.hidden || field.value.length < MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN) continue;
        for (const form of passwordRedactionForms(field.value)) forms.add(form);
      }
    } catch (error) {
      if (error instanceof VaultKeyUnavailableError) throw error;
      // Like an unreadable command variable, it must not stop every computer tool. The id only:
      // an operator can see which login is no longer hidden. Not under a "secret" key, which
      // the logger scrubs.
      getLogger().warn("saved login could not be loaded for redaction", { loginId: row.id });
    }
  }
  return [...forms];
}

/**
 * The login field a fill names: by its label, or "username" and "password" for the first visible
 * and the first hidden field, as a login saved before fields existed was filled.
 */
export function findLoginField(fields: readonly LoginField[], name: string) {
  const labelled = fields.find((field) => sameLoginFieldLabel(field.label, name));
  if (labelled) return labelled;
  const key = name.trim().toLowerCase();
  if (key === "username") return fields.find((field) => !field.hidden);
  if (key === "password") return fields.find((field) => field.hidden);
  return undefined;
}

/** A login kept for one run only: its fields with the card's site, stored as one secret. */
export function encodeRunLogin(origin: string, login: string): string {
  return JSON.stringify({ origin, login });
}

const RunCodeValue = z.object({ origin: z.string(), code: z.string() });

/** A code answered in chat, kept with the site it is for until it is typed there. */
export function encodeRunCode(origin: string, code: string): string {
  return JSON.stringify({ origin, code });
}

/** The run's code row as stored, or nothing when it cannot be read; only the error name is logged. */
export async function readRunCode(
  secretStore: Pick<SecretStore, "load">,
  row: { id: string; ciphertext: string },
): Promise<{ origin: string; code: string } | undefined> {
  try {
    return RunCodeValue.parse(JSON.parse(await secretStore.load(row.ciphertext, row.id)));
  } catch (error) {
    getLogger().warn("one-time code could not be read", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

/**
 * Every form of a code the model could be handed: as is, without dashes, URL-encoded, in either
 * case, and as a page draws it per character or in two groups (input-otp widgets put each digit in
 * its own element, which a snapshot reads as one digit per line).
 */
export function oneTimeCodeRedactions(code: string): string[] {
  const forms = new Set<string>();
  const joins = ["\n", "\r\n", " ", "\t", "-", " - "];
  const digits = code.replaceAll("-", "");
  // A bare short number such as 2026 would blank years and prices for the rest of the run.
  const bare = digits.length >= 6 || /[A-Za-z]/.test(digits);
  for (const written of new Set([code, code.toUpperCase(), code.toLowerCase()])) {
    for (const base of new Set([written, written.replaceAll("-", "")])) {
      if (bare) forms.add(base).add(encodeURIComponent(base));
      for (const join of joins) forms.add([...base].join(join));
      const half = Math.ceil(base.length / 2);
      for (const join of joins) forms.add(`${base.slice(0, half)}${join}${base.slice(half)}`);
    }
  }
  // A short form would blank ordinary text in every later result.
  return [...forms].filter((form) => form.length >= ONE_TIME_CODE_MIN_LENGTH);
}

const RunLoginValue = z.object({ origin: z.string(), login: z.string() });

function decodeRunLogin(plaintext: string): LoginSecretValue & { origin: string } {
  const { origin, login } = RunLoginValue.parse(JSON.parse(plaintext));
  return { origin, ...decodeLoginSecret(login) };
}

/** This run's login under `name` that the person chose not to save, if any. */
export async function findRunLogin(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  runId: string,
  name: string,
): Promise<(LoginSecretValue & { origin: string }) | undefined> {
  const row = await prisma.secret.findFirst({
    where: { userId: scope.userId, spaceId: scope.spaceId, kind: runLoginKind(runId, name) },
    select: { id: true, ciphertext: true },
  });
  return row ? decodeRunLogin(await secretStore.load(row.ciphertext, row.id)) : undefined;
}

/**
 * Redaction forms of this run's logins that weren't saved, from the start of the run: hidden
 * fields as every run hides a saved login's, and every field as the run that fills one does.
 */
export async function loadRunLoginRedactions(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  runId: string,
): Promise<string[]> {
  const rows = await prisma.secret.findMany({
    where: {
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: { startsWith: runLoginKind(runId, "") },
    },
    select: { id: true, ciphertext: true },
  });
  const forms = new Set<string>();
  for (const row of rows) {
    const { fields } = decodeRunLogin(await secretStore.load(row.ciphertext, row.id));
    for (const form of loginFillRedactions(fields)) forms.add(form);
    for (const field of fields) {
      if (!field.hidden || field.value.length < MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN) continue;
      for (const form of passwordRedactionForms(field.value)) forms.add(form);
    }
  }
  return [...forms];
}

function loginFillRedactions(fields: readonly LoginField[]): string[] {
  return [
    ...new Set(
      fields
        .filter((entry) => entry.hidden || entry.value.length >= MIN_REDACTED_VISIBLE_VALUE)
        .flatMap((entry) => [entry.value, encodeURIComponent(entry.value)]),
    ),
  ];
}

const HTTPS_ONLY = "Website logins can only be filled on an HTTPS origin.";

/**
 * Resolve one field of a website login for a page fill: this run's login that wasn't saved under
 * the name first, since it is what the person just typed, then a saved one. The caller must pass
 * `origin` to the page browser, which refuses to fill unless the page is still on that origin,
 * and must type a hidden field only into a password field.
 */
export async function resolveLoginFill(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  runId: string;
  name: string;
  field: string;
}): Promise<
  { text: string; hidden: boolean; origin: string; redactions: string[] } | { error: string }
> {
  const runLogin = await findRunLogin(
    input.prisma,
    input.secretStore,
    input.scope,
    input.runId,
    input.name,
  );
  const row = runLogin
    ? undefined
    : await input.prisma.vaultCredential.findFirst({
        where: { ...(await vaultFields(input.prisma, input.scope)), name: input.name },
      });
  const stored = runLogin
    ? { name: input.name, origin: runLogin.origin, auth: { type: "login" } }
    : row;
  if (!stored) return { error: "Login is unavailable. Use request_secret to save it first." };
  const storedType = BotSecretAuth.safeParse(stored.auth).data?.type;
  if (storedType === "card") {
    return { error: "This is a saved card. Type it with browser_act fill_card, passing card." };
  }
  if (storedType === "contact") {
    return {
      error:
        "A contact is not secret: read it with list_secrets and type it with browser_act fill.",
    };
  }
  if (isCommandCredential(stored.auth)) {
    return {
      error: `${UNUSABLE_CREDENTIAL}. Command variables are only available to shell commands.`,
    };
  }
  // Checked on the stored origin itself, so the private-LAN HTTP allowance cannot widen a login.
  let storedOrigin: URL;
  try {
    storedOrigin = new URL(stored.origin);
  } catch {
    return { error: HTTPS_ONLY };
  }
  if (storedOrigin.protocol !== "https:") return { error: HTTPS_ONLY };
  const destination = normalizeSecretDestination(stored);
  if (destination.auth.type !== "login") {
    return { error: "This credential is not a website login." };
  }
  if (destination.origin !== storedOrigin.origin) return { error: HTTPS_ONLY };
  const { fields } =
    runLogin ?? decodeLoginSecret(await openVaultValue(input.prisma, input.secretStore, row!));
  const field = findLoginField(fields, input.field);
  if (!field) {
    return {
      error: `This login has no field named ${JSON.stringify(input.field)}. Its fields: ${fields.map((entry) => entry.label).join(", ")}.`,
    };
  }
  return {
    text: field.value,
    hidden: field.hidden,
    origin: destination.origin,
    redactions: loginFillRedactions(fields),
  };
}

/**
 * Redaction forms of this run's codes, those waiting and those the page took, from the start of
 * every attempt: a filled code stays on its page and in what the run has read.
 */
export async function loadRunCodeRedactions(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  runId: string,
): Promise<string[]> {
  const rows = await prisma.secret.findMany({
    where: {
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: { in: [runCodeKind(runId), runCodeSpentKind(runId)] },
    },
    select: { id: true, ciphertext: true },
  });
  const forms = new Set<string>();
  for (const row of rows) {
    const held = await readRunCode(secretStore, row);
    for (const form of held ? oneTimeCodeRedactions(held.code) : []) forms.add(form);
  }
  return [...forms];
}

const NO_CODE_WAITING =
  "No code is waiting. Use request_secret with oneTimeCode to ask the user for it first.";

/**
 * This run's code for a page fill. Like a login's, the caller must pass `origin` to the page
 * browser, which refuses to fill unless the page is still on it. The code is only read here:
 * `claim` takes it for one fill, atomically, so two fills never both get it, and `restore` gives
 * it back when the page refused, so the fill can be tried again on the right page. A claimed code
 * stays as a spent row, which the run keeps hiding until it ends.
 */
export async function resolveCodeFill(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  runId: string;
}): Promise<
  | {
      text: string;
      origin: string;
      redactions: string[];
      claim: () => Promise<boolean>;
      restore: () => Promise<void>;
    }
  | { error: string }
> {
  const where = { userId: input.scope.userId, spaceId: input.scope.spaceId };
  const row = await input.prisma.secret.findFirst({
    where: { ...where, kind: runCodeKind(input.runId) },
    select: { id: true, ciphertext: true },
  });
  if (!row) return { error: NO_CODE_WAITING };
  const held = await readRunCode(input.secretStore, row);
  if (!held) return { error: "This code could not be loaded." };
  if (!URL.canParse(held.origin) || new URL(held.origin).protocol !== "https:")
    return { error: NOT_HTTPS_CODE };
  const move = async (from: string, to: string) =>
    (
      await input.prisma.secret.updateMany({
        where: { id: row.id, kind: from },
        data: { kind: to },
      })
    ).count === 1;
  return {
    text: held.code,
    origin: held.origin,
    redactions: oneTimeCodeRedactions(held.code),
    claim: () => move(runCodeKind(input.runId), runCodeSpentKind(input.runId)),
    restore: async () => {
      await move(runCodeSpentKind(input.runId), runCodeKind(input.runId));
    },
  };
}

/**
 * One field of a saved card for browser_act fill_card, only on `site`: the checkout the person
 * approved typing this card into. The caller passes the returned origin to the page browser,
 * which refuses to fill unless the page is still on it. The number's forms are returned for the
 * run to hide; later runs hide them too, through loadLoginPasswordRedactions.
 */
export async function resolveVaultCardFill(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  scope: BotSecretScope;
  name: string;
  field: PurchaseCardField;
  site: string;
  /** When the approved card was last saved; a card replaced since then is not typed. */
  savedAt: string;
}): Promise<{ text: string; origin: string; redactions: string[] } | { error: string }> {
  const target = OneTimeCodeTarget.safeParse({ origin: input.site });
  if (!target.success) return { error: "site must be the checkout page's HTTPS origin." };
  const vault = await vaultFields(input.prisma, input.scope);
  const row = await input.prisma.vaultCredential.findFirst({
    where: { ...vault, name: input.name },
  });
  if (!row || BotSecretAuth.safeParse(row.auth).data?.type !== "card") {
    return { error: "No card is saved under this name. Check list_secrets." };
  }
  if (row.updatedAt.toISOString() !== input.savedAt) {
    return {
      error:
        "This card changed after the user approved it, so nothing was typed. Call browser_act again to ask them.",
    };
  }
  const card = decodeCardSecret(await openVaultValue(input.prisma, input.secretStore, row));
  const origin = new URL(target.data.origin).origin;
  const redactions = cardRedactionForms(card.number);
  if (input.field === "number") return { text: card.number, origin, redactions };
  if (input.field === "expiry") return { text: cardExpiry(card), origin, redactions };
  if (input.field === "cvc") {
    // Only the number is hidden, as for a wallet card: hiding 3 or 4 digits would blank every total
    // and order number that contains them for the rest of the run.
    return card.cvc
      ? { text: card.cvc, origin, redactions }
      : { error: "This card has no security code saved." };
  }
  const billing = card.billing
    ? await input.prisma.vaultCredential.findFirst({ where: { ...vault, name: card.billing } })
    : null;
  const postalCode =
    billing && BotSecretAuth.safeParse(billing.auth).data?.type === "contact"
      ? decodeContactSecret(await openVaultValue(input.prisma, input.secretStore, billing))
          .postalCode
      : undefined;
  return postalCode
    ? { text: postalCode, origin, redactions }
    : {
        error:
          "This card has no billing postal code saved. Type the postal code of the user's billing address yourself.",
      };
}
