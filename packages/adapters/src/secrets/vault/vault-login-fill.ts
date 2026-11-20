import type { SecretStore } from "@rakazo/adapter-kit";
import type { LoginField, LoginSecretValue, PurchaseCardField } from "@rakazo/contracts";
import {
  authenticatorKey,
  BotSecretAuth,
  cardExpiry,
  decodeCardSecret,
  decodeContactSecret,
  decodeLoginSecret,
  OneTimeCodeTarget,
  sameLoginFieldLabel,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runLoginKind } from "@rakazo/db";
import { z } from "zod";
import {
  isCommandCredential,
  normalizeSecretDestination,
  UNUSABLE_CREDENTIAL,
} from "../bot-secret-destination.js";
import { totpCode, totpCodeEnd } from "./totp.js";
import type { BotSecretScope, VaultItemUse } from "./vault-access.js";
import { usableVaultFields } from "./vault-access.js";
import type { VaultLoginUse } from "./vault-card-use.js";
import { LOGIN_CODE_FIELD } from "./vault-card-use.js";
import { LOGIN_CODES_USED_UP } from "./vault-codes.js";
import {
  authenticatorKeyRedactionForms,
  cardRedactionForms,
  loginFillRedactions,
  MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN,
  oneTimeCodeRedactions,
  passwordRedactionForms,
} from "./vault-redaction.js";
import { openVaultValue } from "./vault-values.js";

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
  /** The user's approval of this call, which a login that asks first needs. */
  approval?: VaultLoginUse;
  /** The page the run's browser last reported; a login fills there when it is one of its sites. */
  pageUrl?: string;
  /** The current code of the login's authenticator key instead of a field. */
  code?: true;
}): Promise<
  | {
      text: string;
      hidden: boolean;
      origin: string;
      /** Every site the login fills on. */
      sites: string[];
      redactions: string[];
      used?: VaultItemUse;
      /** For a saved login's code: the login and the stored value the code came from, for loginCodeClaim. */
      login?: { id: string; ciphertext: string };
      /** For a code: until when it is the authenticator's current one, in epoch milliseconds. */
      codeEnds?: number;
    }
  | { error: string }
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
        where: { ...(await usableVaultFields(input.prisma, input.scope)), name: input.name },
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
  // The page browser still types only while the page is on the one origin sent, so a stale or
  // redirected page is refused there, and an older computer image needs no change.
  const page = input.pageUrl && URL.canParse(input.pageUrl) ? new URL(input.pageUrl).origin : "";
  const { approval } = input;
  // An approved call is replayed in a fresh attempt that hasn't seen the page yet, so it fills on
  // the site the user approved while that is still one of the login's.
  const approvedSite =
    row?.policy === "ask" &&
    approval &&
    [destination.origin, ...(row.alsoOn ?? [])].includes(approval.site)
      ? approval.site
      : undefined;
  const origin = approvedSite ?? (row?.alsoOn?.includes(page) ? page : destination.origin);
  // Read again here, so the login as it is now is the one the user approved, on this site.
  if (row?.policy === "ask") {
    if (
      approval?.login !== row.name ||
      approval.site !== origin ||
      !approval.fields.includes(input.code ? LOGIN_CODE_FIELD : input.field.trim())
    )
      return { error: "The user has not approved signing in with this login here." };
    if (approval.savedAt !== row.updatedAt.toISOString())
      return {
        error:
          "This login changed after the user approved it, so nothing was typed. Call browser_act again to ask them.",
      };
  }
  const { fields, otp } =
    runLogin ?? decodeLoginSecret(await openVaultValue(input.prisma, input.secretStore, row!));
  const key = input.code && otp ? authenticatorKey(otp) : undefined;
  if (input.code && !key)
    return { error: "This login has no authenticator key. Use request_secret with oneTimeCode." };
  if (input.code && row?.codesStoppedAt) return { error: LOGIN_CODES_USED_UP };
  const now = Date.now();
  const code = key && totpCode(key, now);
  const field = code ? { value: code, hidden: true } : findLoginField(fields, input.field);
  if (!field) {
    return {
      error: `This login has no field named ${JSON.stringify(input.field)}. Its fields: ${fields.map((entry) => entry.label).join(", ")}.`,
    };
  }
  return {
    text: field.value,
    hidden: field.hidden,
    origin,
    sites: [destination.origin, ...(row?.alsoOn ?? [])],
    // Its key too, which may be newer than the run: the run hides from then on the key it used.
    redactions: [
      ...(code ? oneTimeCodeRedactions(code) : loginFillRedactions(fields)),
      ...(otp ? authenticatorKeyRedactionForms(otp) : []),
    ],
    // Only a saved login is a vault item; this run's own login was never saved.
    ...(row && { used: { id: row.id, name: row.name, spaceId: row.spaceId, kind: "login" } }),
    ...(row && input.code && { login: { id: row.id, ciphertext: row.ciphertext } }),
    ...(key && { codeEnds: totpCodeEnd(key, now) }),
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
}): Promise<
  { text: string; origin: string; redactions: string[]; used: VaultItemUse } | { error: string }
> {
  const target = OneTimeCodeTarget.safeParse({ origin: input.site });
  if (!target.success) return { error: "site must be the checkout page's HTTPS origin." };
  const usable = await usableVaultFields(input.prisma, input.scope);
  const row = await input.prisma.vaultCredential.findFirst({
    where: { ...usable, name: input.name },
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
  const fill = {
    origin: new URL(target.data.origin).origin,
    redactions: cardRedactionForms(card.number),
    used: { id: row.id, name: row.name, spaceId: row.spaceId, kind: "card" },
  };
  if (input.field === "number") return { text: card.number, ...fill };
  if (input.field === "expiry") return { text: cardExpiry(card), ...fill };
  if (input.field === "cvc") {
    // Only the number is hidden, as for a wallet card: hiding 3 or 4 digits would blank every total
    // and order number that contains them for the rest of the run.
    return card.cvc
      ? { text: card.cvc, ...fill }
      : { error: "This card has no security code saved." };
  }
  const billing = card.billing
    ? await input.prisma.vaultCredential.findFirst({ where: { ...usable, name: card.billing } })
    : null;
  const postalCode =
    billing && BotSecretAuth.safeParse(billing.auth).data?.type === "contact"
      ? decodeContactSecret(await openVaultValue(input.prisma, input.secretStore, billing))
          .postalCode
      : undefined;
  // A billing contact the bot can't use, or one removed, is withheld, not left for it to guess.
  if (card.billing && !billing)
    return { error: "This card has no billing address this bot can use." };
  return postalCode
    ? { text: postalCode, ...fill }
    : {
        error:
          "This card has no billing postal code saved. Type the postal code of the user's billing address yourself.",
      };
}
