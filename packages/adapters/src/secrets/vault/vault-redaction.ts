import type { SecretStore } from "@rakazo/adapter-kit";
import type { BotSecretDestination, LoginField } from "@rakazo/contracts";
import {
  authenticatorKey,
  BotSecretAuth,
  decodeCardSecret,
  decodeLoginSecret,
  ONE_TIME_CODE_MIN_LENGTH,
} from "@rakazo/contracts";
import { mapConcurrent } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { ContentDecryptionError, ciphertextKeyId } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { credentialHeader, percentEncoded } from "../bot-secret-destination.js";
import type { BotSecretScope } from "./vault-access.js";
import { VAULT_UNLOCK_CONCURRENCY, vaultFields, vaultRow } from "./vault-access.js";
import { openVaultValue } from "./vault-values.js";

export function commandRedactionForms(value: string): string[] {
  const forms = [value, Buffer.from(value).toString("base64")];
  const encoded = percentEncoded(value);
  if (encoded !== undefined) forms.push(encoded);
  return forms;
}

// Redaction is substring replacement, so a short visible value would mangle unrelated text.
const MIN_REDACTED_VISIBLE_VALUE = 6;
export const MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN = MIN_REDACTED_VISIBLE_VALUE;

export function passwordRedactionForms(password: string): string[] {
  return [
    ...new Set([
      ...commandRedactionForms(password),
      // A submitted form encodes `+` for spaces and escapes `!'()~`, unlike encodeURIComponent.
      new URLSearchParams({ v: password }).toString().slice(2),
    ]),
  ];
}

/**
 * An authenticator key as a page or file may show it: as saved, as its base32 secret in either case
 * and in groups of four, and as the secret of its setup link, each in a password's encodings.
 */
export function authenticatorKeyRedactionForms(otp: string): string[] {
  const secret = authenticatorKey(otp)?.secret ?? "";
  const link = URL.canParse(otp)
    ? ([...new URL(otp).searchParams].find(([name]) => name.toLowerCase() === "secret")?.[1] ?? "")
    : "";
  const groups = secret.match(/.{1,4}/g) ?? [];
  // As saved, inside its link, plain, and in fours spaced or dashed, each in either case.
  return [otp, link, secret, groups.join(" "), groups.join("-")]
    .flatMap((form) => [form, form.toLowerCase()])
    .filter((form) => form.length >= MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN)
    .flatMap(passwordRedactionForms);
}

export function apiKeyRedactionForms(
  destination: BotSecretDestination,
  plaintext: string,
): string[] {
  const { value: headerValue } = credentialHeader(destination, plaintext);
  return [
    ...new Set([
      plaintext,
      headerValue,
      Buffer.from(plaintext).toString("base64"),
      encodeURIComponent(plaintext),
      headerValue.replace(/^Basic /, ""),
    ]),
  ].filter(Boolean);
}

/**
 * A card number as pages show it: as given, digits only, and in groups of four. American Express
 * (15 digits) and Diners Club (14) print as 4-6-5 and 4-6-4.
 */
export function cardRedactionForms(number: string): string[] {
  const digits = number.replace(/\D/g, "");
  const grouped = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
  const hyphenated = digits.replace(/(\d{4})(?=\d)/g, "$1-");
  const long = digits.match(/^(\d{4})(\d{6})(\d{4,5})$/);
  const printed = long ? [long.slice(1).join(" "), long.slice(1).join("-")] : [];
  return [...new Set([number, digits, grouped, hyphenated, ...printed].filter(Boolean))];
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
export async function openForRedaction(
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
 * Redaction forms of every saved login's hidden fields, card number and API key in the vault the
 * run uses. A filled login or card stays on its page after the run that filled it, so each run
 * hides them before any tool output reaches the model. Visible fields stay readable outside the
 * filling run: one is often the user's own email, which ordinary tasks need.
 */
export async function loadLoginPasswordRedactions(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
): Promise<string[]> {
  // Every saved login, card and API key, whether or not this bot may use it: a value an earlier
  // run wrote down stays hidden. Command variables and contacts are not read here.
  const rows = await prisma.vaultCredential.findMany({
    where: {
      ...(await vaultFields(prisma, scope)),
      OR: ["login", "card", "bearer", "header", "basic"].map((type) => ({
        auth: { path: ["type"], equals: type },
      })),
    },
    select: { ...vaultRow, name: true, origin: true, auth: true },
  });
  const perRow = await mapConcurrent(rows, VAULT_UNLOCK_CONCURRENCY, async (row) => {
    const type = BotSecretAuth.safeParse(row.auth).data?.type;
    if (type === "card") {
      try {
        const card = decodeCardSecret(await openForRedaction(prisma, secretStore, row));
        return cardRedactionForms(card.number);
      } catch (error) {
        if (error instanceof VaultKeyUnavailableError) throw error;
        getLogger().warn("saved card could not be loaded for redaction", { cardId: row.id });
        return [];
      }
    }
    if (type === "bearer" || type === "header" || type === "basic") {
      try {
        const plaintext = await openForRedaction(prisma, secretStore, row);
        // A short value would mangle unrelated text in every run; the run that sends it hides it.
        if (plaintext.length < MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN) return [];
        const auth = BotSecretAuth.parse(row.auth);
        return apiKeyRedactionForms({ ...row, auth }, plaintext);
      } catch (error) {
        if (error instanceof VaultKeyUnavailableError) throw error;
        getLogger().warn("saved API key could not be loaded for redaction", { keyId: row.id });
        return [];
      }
    }
    if (type !== "login") return [];
    try {
      const { fields, otp } = decodeLoginSecret(await openForRedaction(prisma, secretStore, row));
      const forms = otp ? [...authenticatorKeyRedactionForms(otp)] : [];
      for (const field of fields) {
        // Every run would mangle each occurrence of a short value; the filling run still hides it.
        if (!field.hidden || field.value.length < MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN) continue;
        forms.push(...passwordRedactionForms(field.value));
      }
      return forms;
    } catch (error) {
      if (error instanceof VaultKeyUnavailableError) throw error;
      // Like an unreadable command variable, it must not stop every computer tool. The id only:
      // an operator can see which login is no longer hidden. Not under a "secret" key, which
      // the logger scrubs.
      getLogger().warn("saved login could not be loaded for redaction", { loginId: row.id });
      return [];
    }
  });
  const forms = new Set(perRow.flat());
  return [...forms];
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

export function loginFillRedactions(fields: readonly LoginField[]): string[] {
  return [
    ...new Set(
      fields
        .filter((entry) => entry.hidden || entry.value.length >= MIN_REDACTED_VISIBLE_VALUE)
        .flatMap((entry) => [entry.value, encodeURIComponent(entry.value)]),
    ),
  ];
}
