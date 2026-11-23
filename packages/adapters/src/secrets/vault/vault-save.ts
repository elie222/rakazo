import { randomBytes } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { BotSecretDestination, SettingsScope, VaultPolicy } from "@rakazo/contracts";
import {
  BotSecretAuth,
  commandVariableName,
  DEFAULT_LOGIN_FIELD_LABELS,
  decodeLoginSecret,
  encodeLoginSecret,
  GeneratedSecretRules,
  GenerateSecretInput,
  loginCommandName,
  VAULT_ITEM_LIMIT,
  vaultLoginKey,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  ContentDecryptionError,
  ciphertextKeyId,
  settingsTarget,
  TransactionConflictError,
  withTransactionRetry,
} from "@rakazo/db";
import {
  botSecretToolView,
  canonicalSecretValue,
  canReplaceLoginSite,
  credentialHeader,
  normalizeSecretDestination,
  percentEncoded,
  resolveRequestSecretDestination,
  sameSecretDestination,
  UNUSABLE_CREDENTIAL,
} from "../bot-secret-destination.js";
import { generateSecretValue } from "../secret-generator.js";
import { persistPreparedSecret } from "../secret-persistence.js";
import { isPermanentDecryptFailure } from "../secrets.js";
import type { BotSecretScope, VaultItemBots } from "./vault-access.js";
import {
  alsoOnField,
  assertVaultInUse,
  getBotSecretMetadata,
  HIDDEN_ITEM,
  hiddenAnswer,
  hiddenFromBot,
  LoginAlreadySavedError,
  lockVault,
  policyField,
  SecretAlreadySavedError,
  saveItemBots,
  UNSUPPORTED_ACCESS,
  VAULT_CHANGED,
  VaultFullError,
  VaultItemRefusedError,
  VaultRetryError,
  vaultFields,
  vaultRow,
} from "./vault-access.js";
import { findCommandVariableConflict } from "./vault-commands.js";
import { findBotSecret } from "./vault-items.js";
import { passwordRedactionForms } from "./vault-redaction.js";
import { openVaultValue, sealVaultValue } from "./vault-values.js";

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
  policy?: VaultPolicy;
  bots?: VaultItemBots;
  /**
   * Refuse a login when one is already saved for its site with the same username. The map keeps
   * each saved login's username as read, by row and value, so one import reads each login once.
   */
  newLoginOnly?: Map<string, string>;
  /** An import using the default vault stops if that selection changes between rows. */
  expectedDefaultVault?: SettingsScope;
  alsoOn?: readonly string[];
}) {
  const { prisma, secretStore, scope } = input;
  let { plaintext } = input;
  if (!plaintext || plaintext.length > 16_384)
    throw new VaultItemRefusedError("Invalid credential length");
  const destination = normalizeSecretDestination(input.destination);
  const policy = policyField(destination.auth, input.policy);
  // A bot never widens where a login goes.
  if (scope.botId && input.alsoOn) throw new VaultItemRefusedError(UNSUPPORTED_ACCESS);
  const sites = alsoOnField(destination.auth, destination.origin, input.alsoOn);
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
      throw new VaultItemRefusedError(UNUSABLE_CREDENTIAL);
    }
  } else credentialHeader(destination, plaintext);
  await assertVaultInUse(prisma, scope);
  const vault = await vaultFields(prisma, scope);
  const existing = await prisma.vaultCredential.findFirst({
    where: { ...vault, name: destination.name },
  });
  // A save the bot started, such as a login card the person answered for the site the bot
  // proposed, moves the login there without its key or other sites: only the owner sets them,
  // for the site they were set for, and the card shows neither. request_secret asks for no
  // such move while the login has either, so this drops only what was added while a card waited.
  const botMoves = (row: typeof existing) =>
    Boolean(scope.botId && row && normalizeSecretDestination(row).origin !== destination.origin);
  // A login saved without its authenticator key keeps the saved one; an empty key removes it.
  const keepsKey =
    destination.auth.type === "login" &&
    existing &&
    !botMoves(existing) &&
    !("otp" in JSON.parse(input.plaintext));
  if (destination.auth.type === "login" && botMoves(existing))
    plaintext = encodeLoginSecret({ fields: decodeLoginSecret(plaintext).fields });
  function validate(row: typeof existing, count: number) {
    if (row && input.createOnly) throw new SecretAlreadySavedError();
    const saved = row && normalizeSecretDestination(row);
    if (
      saved &&
      !sameSecretDestination(saved, destination) &&
      !(row?.id === input.replaces && canReplaceLoginSite(saved, destination))
    )
      throw new VaultItemRefusedError(
        "Remove the existing credential before changing its destination",
      );
    if (!row && count >= VAULT_ITEM_LIMIT) throw new VaultFullError();
  }
  // Before the destination checks, so the person answering is told the item is blocked.
  if (existing && (await hiddenFromBot(prisma, scope, destination.name)))
    throw new VaultItemRefusedError(hiddenAnswer(existing.policy));
  // An import's login already saved is that, also in a full vault.
  const usernames = input.newLoginOnly;
  const repeats = (tx: Pick<Prisma.TransactionClient, "vaultCredential">) =>
    usernames && loginSaved(prisma, tx, secretStore, vault, destination, plaintext, usernames);
  if (await repeats(prisma)) throw new LoginAlreadySavedError();
  validate(existing, await prisma.vaultCredential.count({ where: vault }));
  if (keepsKey) {
    const otp = await savedLoginKey(prisma, secretStore, existing);
    if (otp) plaintext = encodeLoginSecret({ ...decodeLoginSecret(plaintext), otp });
  }
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
      if (
        input.expectedDefaultVault !== undefined &&
        (await settingsTarget(tx, scope, "credentials")) !== input.expectedDefaultVault
      )
        throw new VaultRetryError(VAULT_CHANGED);
      if (existing)
        await tx.$queryRaw`SELECT id FROM vault_credentials WHERE id = ${existing.id} FOR UPDATE`;
      await assertVaultInUse(tx, scope);
      // First under the lock, so an item blocked while the request waited is never replaced.
      const current = await tx.vaultCredential.findFirst({
        where: { ...vault, name: destination.name },
      });
      if (await hiddenFromBot(tx, scope, destination.name))
        throw new VaultItemRefusedError(hiddenAnswer(current?.policy));
      if (JSON.stringify(await vaultFields(tx, scope)) !== JSON.stringify(vault)) {
        throw new TransactionConflictError(VAULT_CHANGED);
      }
      if (await repeats(tx)) throw new LoginAlreadySavedError();
      validate(current, await tx.vaultCredential.count({ where: vault }));
      const conflict = await findCommandVariableConflict(tx, scope, destination);
      if (conflict) {
        throw new VaultItemRefusedError(
          `Invalid credential destination — name: ${conflict} is already exported as $${commandVariableName(destination.name)}`,
        );
      }
      // The kept key was read before the lock, so a value saved since then is read again.
      if (
        current?.id !== existing?.id ||
        (keepsKey && current?.ciphertext !== existing?.ciphertext) ||
        (current && ciphertextKeyId(current.ciphertext) !== ciphertextKeyId(existing!.ciphertext))
      )
        throw new TransactionConflictError("Credential changed while saving; retry");
      const labelled = {
        // Its owner's own save may carry a fixed key, so its codes are typed again. A save a bot
        // started, such as a login card answered in chat, shows no key and keeps the saved one:
        // the key that was stopped is still the one there, so the stop stays.
        ...(current?.codesStoppedAt && !scope.botId ? { codesStoppedAt: null } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...policy,
        ...sites,
        ...(botMoves(current)
          ? { alsoOn: [] }
          : // A login moved to one of its other sites no longer lists that site among them.
            input.alsoOn === undefined && current?.alsoOn?.includes(destination.origin)
            ? { alsoOn: current.alsoOn.filter((site) => site !== destination.origin) }
            : {}),
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
      await saveItemBots(tx, scope, id, input.bots);
      if (usernames && destination.auth.type === "login")
        usernames.set(`${id}:${ciphertext}`, loginUsername(plaintext));
    },
  };
}

/** A saved login that can't be read for now, so a save that would change it waits. */
export const SAVED_LOGIN_UNREADABLE = "The saved login could not be read. Try again.";

/**
 * A saved value, or undefined when it is known to be gone or undecryptable. Any other failure may
 * hide the value, so it throws, never quoting the value.
 */
async function loadSavedValue(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  row: Parameters<typeof openVaultValue>[2],
): Promise<string | undefined> {
  try {
    return await openVaultValue(prisma, secretStore, row);
  } catch (error) {
    const unreadable =
      error instanceof ContentDecryptionError ||
      error instanceof SecretNotFoundError ||
      (!(error instanceof SecretStoreUnavailableError) && isPermanentDecryptFailure(error));
    if (!unreadable) throw new VaultRetryError(SAVED_LOGIN_UNREADABLE);
    return undefined;
  }
}

async function savedLoginKey(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  row: Parameters<typeof openVaultValue>[2] & { auth: unknown },
) {
  if (BotSecretAuth.safeParse(row.auth).data?.type !== "login") return undefined;
  // Only a value no one can read holds no key, so the save replaces it.
  const plaintext = await loadSavedValue(prisma, secretStore, row);
  try {
    return plaintext === undefined ? undefined : decodeLoginSecret(plaintext).otp;
  } catch {
    return undefined;
  }
}

// Also for a login saved before fields. Compared as vaultLoginKey does, as the apps compare it.
function loginUsername(plaintext: string): string {
  return decodeLoginSecret(plaintext).fields.find((field) => !field.hidden)?.value ?? "";
}

async function loginSaved(
  prisma: PrismaClient,
  tx: Pick<Prisma.TransactionClient, "vaultCredential">,
  secretStore: Pick<SecretStore, "load">,
  vault: { userId: string; spaceId: string | null },
  destination: BotSecretDestination,
  plaintext: string,
  usernames: Map<string, string>,
): Promise<boolean> {
  if (destination.auth.type !== "login") return false;
  const login = vaultLoginKey(destination.origin, loginUsername(plaintext));
  const rows = await tx.vaultCredential.findMany({
    // A login that is also on this site fills here too, so it counts.
    where: {
      ...vault,
      OR: [{ origin: destination.origin }, { alsoOn: { has: destination.origin } }],
    },
    select: { ...vaultRow, auth: true },
  });
  for (const row of rows) {
    if (BotSecretAuth.safeParse(row.auth).data?.type !== "login") continue;
    const key = `${row.id}:${row.ciphertext}`;
    let saved = usernames.get(key);
    if (saved === undefined) {
      // One no one can read can't be told apart from this login, so it doesn't count; one that
      // can't be read for now may be this login, so the import stops.
      const plaintext = await loadSavedValue(prisma, secretStore, row);
      if (plaintext === undefined) continue;
      try {
        saved = loginUsername(plaintext);
      } catch {
        continue;
      }
      usernames.set(key, saved);
    }
    if (vaultLoginKey(destination.origin, saved) === login) return true;
  }
  return false;
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
  const found = await findBotSecret(input.prisma, input.scope, name);
  if (found && "hidden" in found) return { result: { error: HIDDEN_ITEM } };
  const existing = found?.destination;
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
  const commandFound = command && (await findBotSecret(input.prisma, input.scope, command.name));
  if (commandFound) {
    return {
      result: {
        error:
          "hidden" in commandFound
            ? HIDDEN_ITEM
            : `A credential named ${command.name} already exists. Use another name for the login.`,
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
