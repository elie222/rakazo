import type { SettingsScope, VaultPolicy } from "@rakazo/contracts";
import {
  BLOCKED_ITEM_ANSWER,
  BotSecretAuth,
  otherSiteOrigin,
  UNCHOSEN_ITEM_ANSWER,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { currentDbContext, lockSpaceSettings, settingsTarget } from "@rakazo/db";

/**
 * The member a credential call acts for, in one Space. `vault` picks the account's vault or the
 * Space's own; omitted, it is whichever this Space uses, which is what bots read and write.
 */
export type BotSecretScope = {
  userId: string;
  spaceId: string;
  vault?: SettingsScope;
  /** Set for a bot's run, which sees only the items it may use; the owner reads without one. */
  botId?: string;
};
type VaultClient = Pick<PrismaClient, "spaceSettingOverride">;

/**
 * Orders a vault write after any change of vault (the member's settings lock) and after every
 * other write by the member, since Spaces without their own vault share the account's.
 */
export async function lockVault(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  scope: BotSecretScope,
) {
  await lockSpaceSettings(tx, scope);
  await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${scope.userId} FOR UPDATE`;
}

export const SPACE_VAULT_NOT_IN_USE = "This Space uses the account vault";
export const VAULT_CHANGED = "Vault changed while saving; retry";

/** A vault item refused for what was given, so the person can change it. Never quotes the value. */
export class VaultItemRefusedError extends ClientError {
  constructor(message: string) {
    super("BAD_REQUEST", message);
    this.name = "VaultItemRefusedError";
  }
}

/** The vault already holds as many items as it may. */
export class VaultFullError extends VaultItemRefusedError {
  constructor() {
    super("Credential limit reached");
    this.name = "VaultFullError";
  }
}

/** A login for the same site and username is already saved. */
export class LoginAlreadySavedError extends VaultItemRefusedError {
  constructor() {
    super(LOGIN_ALREADY_SAVED);
    this.name = "LoginAlreadySavedError";
  }
}

/** The Space no longer keeps its own vault, so a write aimed at it is refused. */
export class SpaceVaultNotInUseError extends VaultItemRefusedError {
  constructor() {
    super(SPACE_VAULT_NOT_IN_USE);
    this.name = "SpaceVaultNotInUseError";
  }
}

/** The vault changed under a save, or what the save depends on can't be read for now: retry. */
export class VaultRetryError extends ClientError {
  constructor(message: string) {
    super("CONFLICT", message);
    this.name = "VaultRetryError";
  }
}

/** A create-only save found the name taken, by an earlier save or a concurrent one. */
export class SecretAlreadySavedError extends Error {
  constructor() {
    super("A credential with this name is already saved");
    this.name = "SecretAlreadySavedError";
  }
}

/**
 * A write aimed at a Space's own vault is refused once the Space stops customizing credentials,
 * since nothing would read it and it would only wait to be deleted.
 */
export async function assertVaultInUse(client: VaultClient, scope: BotSecretScope) {
  if (scope.vault !== "space") return;
  if ((await settingsTarget(client, scope, "credentials")) !== "space") {
    throw new SpaceVaultNotInUseError();
  }
}

/** The vault rows a call reads and writes: the account's (no Space) or the Space's own. */
export async function vaultFields(client: VaultClient, scope: BotSecretScope) {
  const target = await settingsTarget(client, scope, "credentials", scope.vault);
  return { userId: scope.userId, spaceId: target === "space" ? scope.spaceId : null };
}

// Blocked items, and ones chosen for other bots, are still redacted, through
// loadLoginPasswordRedactions and loadCommandVariables.
export async function usableVaultFields(client: VaultClient, scope: BotSecretScope) {
  const vault = await vaultFields(client, scope);
  if (!scope.botId) return vault;
  // Row security shows a tenant only its own limits in its own Space, so a bot's read under another
  // Space's or member's tenant would miss them: it finds nothing instead.
  const context = currentDbContext();
  if (
    context?.kind === "tenant" &&
    (context.spaceId !== scope.spaceId || context.userId !== scope.userId)
  )
    return { ...vault, id: { in: [] } };
  return {
    ...vault,
    policy: { not: "off" },
    // Limited in this Space only to the bots chosen here; another Space's choice never applies.
    OR: [
      { limits: { none: { spaceId: scope.spaceId } } },
      { bots: { some: { botId: scope.botId } } },
    ],
  };
}

// Says nothing of the item, as a name the bot can't use may be taken by one it can't see.
export const HIDDEN_ITEM = "That name can't be used. Use another name.";

/**
 * Which bots in this Space may use an item. `botIds` limits it to those bots; `allBots` true lets
 * every bot use it and forgets the choice; `allBots` false alone keeps the bots chosen before.
 * Left out entirely, nothing changes.
 */
export type VaultItemBots = { allBots?: boolean; botIds?: string[] };
export const UNKNOWN_BOTS = "Choose from your bots in this Space";

/**
 * Sets whether an item is limited in this Space and the bots chosen here, keeping every other
 * Space's. Any bot of a Space that uses the item's vault: in a shared Space every member's runs
 * with a bot read their own vault, so a member's choice only ever limits their own items.
 */
export async function saveItemBots(
  tx: Prisma.TransactionClient,
  scope: BotSecretScope,
  credentialId: string,
  bots: VaultItemBots | undefined,
) {
  if (!bots || scope.botId) return;
  const owner = { userId: scope.userId, spaceId: scope.spaceId };
  // A choice of bots is never kept without the limit it serves, so the two can't drift apart.
  if (bots.allBots) {
    await tx.vaultCredentialLimit.deleteMany({ where: { ...owner, credentialId } });
    await tx.vaultCredentialBot.deleteMany({ where: { ...owner, credentialId } });
    return;
  }
  if (bots.allBots === undefined && !bots.botIds) return;
  const { count: limited } = await tx.vaultCredentialLimit.createMany({
    data: [{ ...owner, credentialId }],
    skipDuplicates: true,
  });
  // Newly limited, the item starts from no bots: rows an earlier save left behind on an
  // unlimited item were never a choice, so they are cleared rather than brought back.
  if (limited && !bots.botIds) {
    await tx.vaultCredentialBot.deleteMany({ where: { ...owner, credentialId } });
    return;
  }
  if (!bots.botIds) return;
  const botIds = [...new Set(bots.botIds)];
  if (botIds.length) {
    const [here, item] = await Promise.all([vaultFields(tx, owner), vaultFields(tx, scope)]);
    const found = await tx.bot.count({ where: { spaceId: scope.spaceId, id: { in: botIds } } });
    if (here.spaceId !== item.spaceId || found !== botIds.length)
      throw new VaultItemRefusedError(UNKNOWN_BOTS);
  }
  await tx.vaultCredentialBot.deleteMany({
    where: { ...owner, credentialId, botId: { notIn: botIds } },
  });
  await tx.vaultCredentialBot.createMany({
    data: botIds.map((botId) => ({ ...owner, credentialId, botId })),
    skipDuplicates: true,
  });
}

// What the person answering for a bot is told of an item it can't use: Blocked, or limited to others.
export const hiddenAnswer = (policy: string | undefined) =>
  policy === "off" ? BLOCKED_ITEM_ANSWER : UNCHOSEN_ITEM_ANSWER;

// A blocked name stays taken, so a bot can't save another item over it.
export async function hiddenFromBot(
  client: PrismaClient | Prisma.TransactionClient,
  scope: BotSecretScope,
  name: string,
) {
  if (!scope.botId) return false;
  const [saved, usable] = await Promise.all([
    client.vaultCredential.count({ where: { ...(await vaultFields(client, scope)), name } }),
    client.vaultCredential.count({ where: { ...(await usableVaultFields(client, scope)), name } }),
  ]);
  return saved > usable;
}

export const metadata = { name: true, origin: true, auth: true } as const;
// What people see of an item besides its destination.
export const labels = { title: true, note: true } as const;
// What reading an item's value needs: the vault it is in is part of its encryption.
export const vaultRow = { id: true, userId: true, spaceId: true, ciphertext: true } as const;

export function isSecretAlreadySaved(error: unknown): boolean {
  return error instanceof SecretAlreadySavedError;
}

/**
 * How many vault values a run unlocks at once. A value kept in a remote secret store is a network
 * read, and a full vault would otherwise wait on each in turn.
 */
export const VAULT_UNLOCK_CONCURRENCY = 8;

export const LOGIN_ALREADY_SAVED = "A login for this site and username is already saved";

// Owner-facing view: destination, labels and timestamps only, never the row id or ciphertext.
export const ownerMetadata = { ...metadata, ...labels, createdAt: true, updatedAt: true } as const;

// A contact isn't secret, so bots always see it. Only a login can ask first.
export function policyField(auth: unknown, policy: VaultPolicy | undefined) {
  if (!policy) return {};
  const type = BotSecretAuth.safeParse(auth).data?.type;
  if (type === "contact" || (policy === "ask" && type !== "login"))
    throw new VaultItemRefusedError(UNSUPPORTED_ACCESS);
  return { policy };
}

export const UNSUPPORTED_ACCESS = "This item can't be used that way";

/** A login's other sites as saved: HTTPS origins, each once, without its own site. */
export function alsoOnField(auth: unknown, origin: string, alsoOn: readonly string[] | undefined) {
  if (alsoOn === undefined) return {};
  if (alsoOn.length && BotSecretAuth.safeParse(auth).data?.type !== "login")
    throw new VaultItemRefusedError(UNSUPPORTED_ACCESS);
  // The editors' own check, so a site they let through is never refused here.
  const sites = alsoOn.map((site) => otherSiteOrigin(site.trim()));
  if (sites.some((site) => !site))
    throw new VaultItemRefusedError(
      "Invalid credential destination — every other site must be an HTTPS address a login " +
        "can be saved for",
    );
  return { alsoOn: [...new Set(sites as string[])].filter((site) => site !== origin) };
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
 * An item whose value the vault gave a bot, for the audit log; never the value. A use is recorded
 * where a value leaves for a page (resolveLoginFill, resolveVaultCardFill), a site
 * (requestWithBotSecret) or a shell command (shellCommandEnvironment), once it may have got there.
 * Reading a value only to hide it from output, to show it to its owner, or to compare it inside
 * the vault is no use; nor is a contact, which a bot reads in full as ordinary text.
 */
export type VaultItemUse = { id: string; name: string; spaceId: string | null; kind: string };
