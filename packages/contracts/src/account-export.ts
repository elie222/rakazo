import * as z from "zod";
import { Id, IsoDate, ReplyModeSchema } from "./ids.js";
import { PageSourceSchema, PageTitleSchema } from "./pages.js";

/**
 * A whole account as one zip, to move between Rakazo installs (Cloud to self-hosted and back).
 *
 * - `manifest.json` comes first: the format, version and the exported spaces.
 * - `spaces/<spaceId>/records.jsonl`: one `AccountExportRecord` per line. A record only refers to
 *   records earlier in the same file, except `bot.parentBotId`, which may point forward.
 * - `spaces/<spaceId>/artifacts/<artifactId>`: each artifact's bytes, after the records.
 * - `spaces/<spaceId>/homes/<botId>/<path>`: each bot's workspace files, after the records.
 * - `spaces/<spaceId>/executables.json`: after the workspace files, which of them are executable
 *   (a streamed zip cannot carry file modes back out). Left out when none are.
 *
 * Content is decrypted. Ids are the source install's; an import gives every row a new id and
 * rewrites references, including ids inside message blocks. Credentials, integrations, runs,
 * billing, computers and page links are not exported: they belong to the source install.
 *
 * Version 2 adds an encrypted credentials section (see `AccountExportEncryptedCredentialsSchema`):
 * the user's own credentials, sealed with a key derived from a backup password the exporter
 * supplies with the export request. Version 1 archives have no credentials section and still
 * import. An older server rejects a version 2 archive outright.
 */
/** A page version number, within the database's 32-bit column. */
const PageVersionNumber = z.number().int().positive().max(2_147_483_647);

export const ACCOUNT_EXPORT_FORMAT = "rakazo-account-export";
export const ACCOUNT_EXPORT_VERSION = 2;
export const ACCOUNT_EXPORT_MANIFEST_PATH = "manifest.json";
/**
 * The encrypted credentials section, second in the archive, right after the manifest. Only
 * this entry carries credentials, and only in encrypted form: the backup password and the
 * key derived from it never enter the archive.
 */
export const ACCOUNT_EXPORT_CREDENTIALS_PATH = "credentials.enc.json";
/** The credentials section is kilobytes; anything bigger is not a credentials section. */
export const ACCOUNT_EXPORT_CREDENTIALS_MAX_BYTES = 4 * 1024 * 1024;
/** The backup password must stand alone: the account password's minimum is only 8. */
export const ACCOUNT_EXPORT_BACKUP_PASSWORD_MIN_LENGTH = 12;
/**
 * The backup key derivation, pinned: the salt, N, r, p and key length in an archive must match
 * these exactly, so a hostile archive cannot make the importer derive with a ruinous cost.
 */
export const ACCOUNT_EXPORT_BACKUP_KDF = {
  algorithm: "scrypt",
  n: 32_768,
  r: 8,
  p: 1,
  keyLength: 32,
  saltBytes: 16,
  nonceBytes: 12,
} as const;
/** Larger workspace files stay behind, matching the workspace export limit elsewhere. */
export const ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES = 8 * 1024 * 1024;

export const accountExportPaths = {
  records: (spaceId: string) => `spaces/${spaceId}/records.jsonl`,
  artifact: (spaceId: string, artifactId: string) => `spaces/${spaceId}/artifacts/${artifactId}`,
  homeFile: (spaceId: string, botId: string, path: string) =>
    `spaces/${spaceId}/homes/${botId}/${path}`,
  executables: (spaceId: string) => `spaces/${spaceId}/executables.json`,
};

export const AccountExportExecutablesSchema = z.array(z.object({ botId: Id, path: z.string() }));
export type AccountExportExecutables = z.infer<typeof AccountExportExecutablesSchema>;

export const AccountExportManifestSchema = z.object({
  format: z.literal(ACCOUNT_EXPORT_FORMAT),
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: IsoDate,
  user: z.object({ name: z.string(), email: z.string(), timezone: z.string().nullable() }),
  spaces: z.array(z.object({ id: Id, name: z.string(), createdAt: IsoDate })),
});
export type AccountExportManifest = z.infer<typeof AccountExportManifestSchema>;

/** Base64 of exactly `bytes` bytes: the length is fixed, so the check needs no Buffer. */
const base64OfBytes = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .length(Math.ceil(bytes / 3) * 4);

/** Base64 of any length, as `Buffer.toString("base64")` writes it. */
const base64String = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .refine((value) => value.length % 4 === 0);

/**
 * The encrypted credentials section, `credentials.enc.json`. The KDF parameters are literals,
 * not free values: an archive that claims a larger N is refused before any derivation runs.
 * The AAD is the importing user's id, so one account's section cannot move to another's.
 */
export const AccountExportEncryptedCredentialsSchema = z.object({
  algorithm: z.literal("aes-256-gcm"),
  kdf: z.object({
    algorithm: z.literal("scrypt"),
    n: z.literal(ACCOUNT_EXPORT_BACKUP_KDF.n),
    r: z.literal(ACCOUNT_EXPORT_BACKUP_KDF.r),
    p: z.literal(ACCOUNT_EXPORT_BACKUP_KDF.p),
    keyLength: z.literal(ACCOUNT_EXPORT_BACKUP_KDF.keyLength),
    salt: base64OfBytes(ACCOUNT_EXPORT_BACKUP_KDF.saltBytes),
  }),
  nonce: base64OfBytes(ACCOUNT_EXPORT_BACKUP_KDF.nonceBytes),
  ciphertext: base64String,
  tag: base64OfBytes(16),
});
export type AccountExportEncryptedCredentials = z.infer<
  typeof AccountExportEncryptedCredentialsSchema
>;

const json = z.json();

/** One credential's value, decrypted. A single value is never megabytes; cap it early. */
const credentialPlaintext = z.string().min(1).max(1_048_576);

/**
 * The decrypted credentials section. `spaceId` and `botId` are the source install's ids and
 * are remapped on import; a null `spaceId` is the account vault, shared by every space.
 * Connections and MCP servers with no secret keep their row and no value (`plaintext` /
 * `material` null): the row is still worth restoring so the user can reconnect it.
 */
export const AccountExportCredentialsSchema = z.object({
  version: z.literal(1),
  model: z
    .array(
      z.object({
        provider: z.string().min(1),
        label: z.string(),
        supportsImages: z.boolean(),
        plaintext: credentialPlaintext,
      }),
    )
    .default([]),
  voice: z
    .array(z.object({ provider: z.string().min(1), plaintext: credentialPlaintext }))
    .default([]),
  connections: z
    .array(
      z.object({
        spaceId: z.string(),
        connectorId: z.string(),
        provider: z.string(),
        displayName: z.string(),
        status: z.string(),
        providerRef: z.string().nullable(),
        metadata: json,
        plaintext: credentialPlaintext.nullable(),
      }),
    )
    .default([]),
  mcp: z
    .array(
      z.object({
        spaceId: z.string(),
        slug: z.string(),
        name: z.string(),
        description: z.string(),
        transport: z.string(),
        endpoint: z.string().nullable(),
        command: z.string().nullable(),
        allSpaces: z.boolean(),
        allBots: z.boolean(),
        enabled: z.boolean(),
        verbatimResults: z.boolean(),
        material: json.nullable(),
      }),
    )
    .default([]),
  vault: z
    .array(
      z.object({
        spaceId: z.string().nullable(),
        name: z.string(),
        title: z.string(),
        note: z.string(),
        origin: z.string(),
        auth: json,
        plaintext: credentialPlaintext,
      }),
    )
    .default([]),
  botSecrets: z
    .array(
      z.object({
        spaceId: z.string(),
        botId: z.string(),
        name: z.string(),
        origin: z.string(),
        auth: json,
        plaintext: credentialPlaintext,
      }),
    )
    .default([]),
});
export type AccountExportCredentials = z.infer<typeof AccountExportCredentialsSchema>;

export const AccountExportRecordSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bot_section"),
    id: Id,
    name: z.string(),
    position: z.number().int(),
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("bot"),
    id: Id,
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    color: z.string(),
    avatarSet: z.string(),
    notifyOnFinish: z.boolean(),
    pinned: z.boolean(),
    position: z.number().int(),
    sectionId: Id.nullable(),
    archivedAt: IsoDate.nullable(),
    parentBotId: Id.nullable(),
    memoryScope: z.string().nullable(),
    voiceId: z.string().nullable(),
    autoSpeak: z.boolean(),
    modelProvider: z.string().nullable(),
    modelId: z.string().nullable(),
    thinkingLevel: z.string().nullable(),
    disabledBuiltinTools: z.array(z.string()),
    teamChatAmbientEnabled: z.boolean(),
    teamChatRules: z.string(),
    crossSpaceCommunication: z.boolean(),
    dailyCheckIns: z.boolean().default(true),
    fleetManagement: z.boolean(),
    replyMode: ReplyModeSchema.default("chat"),
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("chat_group"),
    id: Id,
    name: z.string(),
    pinned: z.boolean(),
    sectionId: Id.nullable(),
    archivedAt: IsoDate.nullable(),
    botIds: z.array(Id),
    createdAt: IsoDate,
  }),
  /** A bot's or a group's conversation, or the thread a bot's background helper worked in. */
  z.object({
    type: z.literal("thread"),
    id: Id,
    botId: Id.nullable(),
    groupId: Id.nullable(),
    /** Absent from archives written before helpers had threads. */
    helperBotId: Id.nullable().optional(),
    historyCompactedUpToSeq: z.number().int().nullable(),
    historyCompactionSummary: z.string().nullable(),
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("message"),
    id: Id,
    threadId: Id,
    seq: z.number().int(),
    role: z.string(),
    blocks: json,
    botId: Id.nullable(),
    replyToMessageId: Id.nullable(),
    replyQuote: z.string().nullable(),
    createdAt: IsoDate,
  }),
  /** A page arrives private: its link stays with the source install. */
  z.object({
    type: z.literal("page"),
    id: Id,
    botId: Id.nullable(),
    groupId: Id.nullable(),
    title: PageTitleSchema,
    pinnedAt: IsoDate.nullable(),
    currentVersion: PageVersionNumber,
    createdAt: IsoDate,
    updatedAt: IsoDate,
  }),
  z.object({
    type: z.literal("page_version"),
    id: Id,
    pageId: Id,
    version: PageVersionNumber,
    title: PageTitleSchema,
    source: PageSourceSchema,
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("artifact"),
    id: Id,
    botId: Id.nullable(),
    groupId: Id.nullable(),
    name: z.string(),
    description: z.string().nullable(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    hash: z.string(),
    rootArtifactId: Id.nullable(),
    version: z.number().int().positive(),
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("memory_document"),
    id: Id,
    botId: Id.nullable(),
    scope: z.string(),
    path: z.string(),
    content: z.string(),
    revision: z.number().int(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
  }),
  z.object({
    type: z.literal("memory_revision"),
    id: Id,
    documentId: Id,
    revision: z.number().int(),
    content: z.string(),
    sourceThreadId: Id.nullable(),
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("routine"),
    id: Id,
    botId: Id,
    threadId: Id.nullable(),
    name: z.string(),
    prompt: z.string(),
    crons: z.array(z.string()),
    timezone: z.string(),
    active: z.boolean(),
    notify: z.boolean(),
    messageProvider: z.string().nullable(),
    modelProvider: z.string().nullable(),
    modelId: z.string().nullable(),
    thinkingLevel: z.string().nullable(),
    watch: json.nullable(),
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("scratchpad_item"),
    id: Id,
    botId: Id,
    title: z.string(),
    status: z.string(),
    notes: z.string(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
  }),
  /** Skills the user wrote; built-in and plugin skills come with the install. */
  z.object({
    type: z.literal("agent_skill"),
    id: Id,
    name: z.string(),
    description: z.string(),
    content: z.string(),
    files: json.nullable(),
    createdAt: IsoDate,
  }),
  /** Only in spaces the user owns. */
  z.object({
    type: z.literal("board"),
    id: Id,
    name: z.string(),
    ticketPrefix: z.string(),
  }),
  z.object({
    type: z.literal("ticket"),
    id: Id,
    number: z.number().int().positive(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    priority: z.string().nullable(),
    /** Null when the bot is someone else's, so it is not in the export. */
    assigneeBotId: Id.nullable(),
    createdByBotId: Id.nullable(),
    createdByExporter: z.boolean(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
    completedAt: IsoDate.nullable(),
  }),
  z.object({
    type: z.literal("ticket_comment"),
    id: Id,
    ticketId: Id,
    authorBotId: Id.nullable(),
    authoredByExporter: z.boolean(),
    body: z.string(),
    createdAt: IsoDate,
  }),
]);
export type AccountExportRecord = z.infer<typeof AccountExportRecordSchema>;

export const AccountImportResultSchema = z.object({
  spaces: z.array(z.object({ id: Id, name: z.string() })),
  /**
   * The second, credential phase. Absent for version 1 archives, which have no credentials
   * section. `error` means the section was present but unrestorable (wrong backup password,
   * no password supplied, tampered); the spaces above still imported.
   */
  credentials: z
    .object({
      restored: z.object({
        model: z.number().int().nonnegative(),
        voice: z.number().int().nonnegative(),
        connections: z.number().int().nonnegative(),
        mcp: z.number().int().nonnegative(),
        vault: z.number().int().nonnegative(),
        botSecrets: z.number().int().nonnegative(),
      }),
      skipped: z.object({
        model: z.number().int().nonnegative(),
        voice: z.number().int().nonnegative(),
        connections: z.number().int().nonnegative(),
        mcp: z.number().int().nonnegative(),
        vault: z.number().int().nonnegative(),
        botSecrets: z.number().int().nonnegative(),
      }),
      error: z.string().optional(),
    })
    .optional(),
});
export type AccountImportResult = z.infer<typeof AccountImportResultSchema>;
