import type { SecretStore } from "@rakazo/adapter-kit";
import type {
  CardSecretValue,
  LoginSecretValue,
  VaultPolicy,
  VaultPreview,
} from "@rakazo/contracts";
import {
  BotSecretAuth,
  cardExpiry,
  cardSummary,
  cardTitle,
  decodeCardSecret,
  decodeContactSecret,
  decodeLoginSecret,
} from "@rakazo/contracts";
import { mapConcurrent } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  botSecretToolView,
  canonicalSecretValue,
  normalizeSecretDestination,
} from "../bot-secret-destination.js";
import type { BotSecretScope, VaultItemBots } from "./vault-access.js";
import {
  alsoOnField,
  assertVaultInUse,
  hiddenFromBot,
  labels,
  lockVault,
  metadata,
  ownerMetadata,
  policyField,
  saveItemBots,
  usableVaultFields,
  VAULT_UNLOCK_CONCURRENCY,
  vaultFields,
  vaultRow,
} from "./vault-access.js";
import { openVaultValue } from "./vault-values.js";

/** The credential saved under `name`. Its row id is for a card that replaces it, never for the bot. */
export async function findBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  const row = await prisma.vaultCredential.findFirst({
    where: { ...(await vaultFields(prisma, scope)), name },
    select: { ...metadata, id: true, alsoOn: true },
  });
  if (!row) return null;
  if (await hiddenFromBot(prisma, scope, name)) return { hidden: true as const };
  return { id: row.id, destination: normalizeSecretDestination(row), alsoOn: row.alsoOn ?? [] };
}

/**
 * The one login saved for exactly this HTTPS site, or when none is, the one with it among its other
 * sites, whatever its name. Bots name logins themselves, so a later request under another name for
 * the same site still finds it. None when two match.
 */
export async function findSiteLogin(prisma: PrismaClient, scope: BotSecretScope, origin: string) {
  if (!origin.startsWith("https://")) return null;
  const rows = await prisma.vaultCredential.findMany({
    where: {
      ...(await usableVaultFields(prisma, scope)),
      // Its own OR, so the bot access filter's OR still applies.
      AND: [{ OR: [{ origin }, { alsoOn: { has: origin } }] }],
    },
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
  const own = logins.filter((login) => login.origin === origin);
  const found = own.length ? own : logins;
  return found.length === 1 ? found[0] : null;
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
    where: await usableVaultFields(prisma, scope),
    select: { ...metadata, ...labels, ...vaultRow, alsoOn: true },
    orderBy: { name: "asc" },
  });
  // Each preview may be a remote store read: a full Vault reads a few at a time.
  return mapConcurrent(
    rows,
    VAULT_UNLOCK_CONCURRENCY,
    async ({ id, userId, spaceId, ciphertext, title, note, alsoOn, ...row }) => {
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
        ...loginHints(alsoOn, preview),
        ...(title ? { title } : {}),
        ...(note ? { note } : {}),
        ...(preview?.card
          ? { card: { ...preview.card, expiry: cardExpiry(preview.card) } }
          : preview?.contact
            ? { contact: preview.contact }
            : {}),
      };
    },
  );
}

// Where else a login fills, and that it can type its authenticator code; never the key.
function loginHints(alsoOn: string[] | undefined, preview: VaultPreview | undefined) {
  return {
    ...(alsoOn?.length ? { alsoOn } : {}),
    ...(preview?.otp ? { authenticatorCode: true } : {}),
  };
}

/** A saved login's hints for the bot, for request_secret's answer that it is already saved. */
export async function loginToolHints(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  name: string,
) {
  const row = await prisma.vaultCredential.findFirst({
    where: { ...(await usableVaultFields(prisma, scope)), name },
    select: { ...vaultRow, auth: true, alsoOn: true },
  });
  return row ? loginHints(row.alsoOn, await itemPreview(prisma, secretStore, row)) : {};
}

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
    const { fields, otp } = decodeLoginSecret(plaintext);
    const username = fields.find((field) => !field.hidden)?.value;
    return { ...(username ? { username } : {}), ...(otp ? { otp: true as const } : {}) };
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
  /** Off when only its metadata is needed: the preview decrypts the value. */
  withPreview = true,
) {
  const rows = await prisma.vaultCredential.findMany({
    where: { ...(await usableVaultFields(prisma, scope)), ...(name !== undefined ? { name } : {}) },
    select: { ...ownerMetadata, ...vaultRow, policy: true, alsoOn: true },
    orderBy: { name: "asc" },
  });
  // Whether each is limited in this Space, and the bots chosen here.
  const here = {
    userId: scope.userId,
    spaceId: scope.spaceId,
    credentialId: { in: rows.map((row) => row.id) },
  };
  const [limited, chosen] = await Promise.all([
    prisma.vaultCredentialLimit.findMany({ where: here, select: { credentialId: true } }),
    prisma.vaultCredentialBot.findMany({
      where: here,
      select: { credentialId: true, botId: true },
    }),
  ]);
  const limitedIds = new Set(limited.map((entry) => entry.credentialId));
  const botsOf = new Map<string, string[]>();
  for (const { credentialId, botId } of chosen)
    botsOf.set(credentialId, [...(botsOf.get(credentialId) ?? []), botId]);
  // Each preview may be a remote store read: a full Vault reads a few at a time.
  return mapConcurrent(
    rows,
    VAULT_UNLOCK_CONCURRENCY,
    async ({ id, userId, spaceId, ciphertext, ...row }) => {
      const preview = withPreview
        ? await itemPreview(prisma, secretStore, {
            id,
            userId,
            spaceId,
            ciphertext,
            auth: row.auth,
          })
        : undefined;
      // A choice exists only while the item is limited: one left behind by an earlier save is none.
      const allBots = !limitedIds.has(id);
      const botIds = allBots ? [] : (botsOf.get(id) ?? []);
      return { ...row, allBots, botIds, title: vaultItemTitle(row, preview), preview };
    },
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
    // Runs are already one dash, so one trailing dash is all there is to drop.
    .replace(/^[^a-z]+|-$/g, "")
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

/** Change only what people call an item, when to use it, and when bots may use it. */
export async function relabelVaultItem(
  prisma: PrismaClient,
  scope: BotSecretScope,
  name: string,
  labels: {
    title?: string;
    note?: string;
    policy?: VaultPolicy;
    bots?: VaultItemBots;
    alsoOn?: readonly string[];
  },
) {
  await assertVaultInUse(prisma, scope);
  // Only these columns: the rest of a request never reaches the row.
  const data = {
    ...(labels.title !== undefined ? { title: labels.title } : {}),
    ...(labels.note !== undefined ? { note: labels.note } : {}),
  };
  return prisma.$transaction(async (tx) => {
    await lockVault(tx, scope);
    await assertVaultInUse(tx, scope);
    const row = await tx.vaultCredential.findFirst({
      where: { ...(await vaultFields(tx, scope)), name },
      select: { id: true, auth: true, origin: true },
    });
    if (!row) return false;
    await tx.vaultCredential.update({
      where: { id: row.id },
      data: {
        ...data,
        ...policyField(row.auth, labels.policy),
        ...alsoOnField(row.auth, row.origin, labels.alsoOn),
      },
    });
    await saveItemBots(tx, scope, row.id, labels.bots);
    return true;
  });
}

export async function vaultItemId(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  const row = await prisma.vaultCredential.findFirst({
    where: { ...(await vaultFields(prisma, scope)), name },
    select: { id: true },
  });
  return row?.id;
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
  return prisma.$transaction(async (tx) => {
    await lockVault(tx, scope);
    // A bot can't remove an item it may not see, and is told what it would be of a missing one.
    if (await hiddenFromBot(tx, scope, name)) return { removed: false };
    const { count } = await tx.vaultCredential.deleteMany({
      where: { ...(await vaultFields(tx, scope)), name },
    });
    return { removed: count > 0 };
  });
}
