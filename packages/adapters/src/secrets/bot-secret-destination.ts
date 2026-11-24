import type { BotSecretDestination } from "@rakazo/contracts";
import {
  AUTHENTICATOR_KEY_UNREADABLE,
  BotSecretAuth,
  BotSecretName,
  botSecretDestinationSchema,
  commandVariableName,
  commandVariableProblem,
  decodeLoginSecret,
  encodeCardSecret,
  encodeContactSecret,
  encodeLoginSecret,
  isSitelessAuth,
  LOGIN_FIELD_LIMIT,
  LoginFieldLabels,
  OneTimeCodeTarget,
} from "@rakazo/contracts";
import { isRecord } from "@rakazo/core";
import { z } from "zod";
import { VaultItemRefusedError } from "./vault/vault-access.js";

export const UNUSABLE_CREDENTIAL = "Credential cannot be used with this authentication method";

/** `encodeURIComponent` throws on an unpaired surrogate. */
export function percentEncoded(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function credentialHeader(destination: BotSecretDestination, plaintext: string) {
  // A login is only typed into its site, a command variable only reaches shell commands, and a
  // card or contact is only typed into pages.
  if (
    destination.auth.type !== "bearer" &&
    destination.auth.type !== "header" &&
    destination.auth.type !== "basic"
  ) {
    throw new VaultItemRefusedError(UNUSABLE_CREDENTIAL);
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
    throw new VaultItemRefusedError(UNUSABLE_CREDENTIAL);
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
    throw new VaultItemRefusedError(`Invalid credential destination — ${detail}`);
  }
  if (isSitelessAuth(parsed.data.auth.type)) return parsed.data;
  return { ...parsed.data, origin: new URL(parsed.data.origin).origin };
}

export function isCommandCredential(auth: unknown): boolean {
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

/** The bot must tell the user why it falls back to a takeover, so the refusal says so. */
export const NOT_HTTPS_CODE =
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
          error instanceof VaultItemRefusedError
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
    const origin = isRecord(args.oneTimeCode) ? args.oneTimeCode.origin : undefined;
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
  if (!isRecord(value)) return value === undefined ? undefined : {};
  return { origin: originMetadata(value.origin) ?? "invalid-origin" };
}

/** Labels only, also from `{ label, hidden }` objects, so a bot's `hidden` is never recorded. */
export function loginFieldLabelsArgument(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((field) => (isRecord(field) ? field.label : field))
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
  if (!isRecord(value)) return undefined;
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
    return isRecord(value) ? destinationMetadata(value) : {};
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) return destinationMetadata(parsed);
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

/**
 * Reads a value the person gave. One that isn't of its kind is theirs to fix, named without
 * quoting it: a parse error can repeat the value.
 */
function readGivenValue<T>(read: () => T, refusal: (issues: z.ZodError["issues"]) => string): T {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
    throw new VaultItemRefusedError(refusal(error instanceof z.ZodError ? error.issues : []));
  }
}

/** Reads a login the person gave, refusing one without a label and value for every field. */
function readLoginValue<T>(read: () => T): T {
  return readGivenValue(read, (issues) =>
    issues.some((issue) => issue.path[0] === "otp")
      ? AUTHENTICATOR_KEY_UNREADABLE
      : "A website login needs a label and a value for every field",
  );
}

/** A login read from an export, as it is saved. */
export function importedLoginValue(login: Parameters<typeof encodeLoginSecret>[0]): string {
  return readLoginValue(() => encodeLoginSecret(login));
}

/**
 * The value as it is saved: a login, card or contact in its current shape, so every reader gets
 * one form. Throws when the value is not one of its kind.
 */
export function canonicalSecretValue(destination: BotSecretDestination, plaintext: string): string {
  const { type } = destination.auth;
  // Saved in its current shape, also when an older app sends a username and password.
  if (type === "login")
    return readLoginValue(() => {
      const { fields, otp } = decodeLoginSecret(plaintext);
      return encodeLoginSecret(otp ? { fields, otp } : { fields });
    });
  if (type === "card")
    return readGivenValue(
      () => encodeCardSecret(JSON.parse(plaintext)),
      () => "Invalid card",
    );
  if (type === "contact")
    return readGivenValue(
      () => encodeContactSecret(JSON.parse(plaintext)),
      () => "Invalid contact",
    );
  return plaintext;
}
