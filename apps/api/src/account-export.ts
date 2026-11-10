import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  SecretStore,
} from "@rakazo/adapter-kit";
import { resolveBotWorkspacePath } from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import type {
  AccountExportExecutables,
  AccountExportManifest,
  AccountExportRecord,
} from "@rakazo/contracts";
import {
  ACCOUNT_EXPORT_BACKUP_PASSWORD_MIN_LENGTH,
  ACCOUNT_EXPORT_CREDENTIALS_PATH,
  ACCOUNT_EXPORT_FORMAT,
  ACCOUNT_EXPORT_MANIFEST_PATH,
  ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES,
  ACCOUNT_EXPORT_VERSION,
  accountExportPaths,
} from "@rakazo/contracts";
import type { AccountExportSource, PrismaClient } from "@rakazo/db";
import {
  accountDeactivated,
  parseComputerMode,
  readAccountExport,
  readAccountExportCredentials,
  recordSecurityEvent,
  runAsTenant,
  runGeneratorAsTenant,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { Zip, ZipDeflate } from "fflate";
import type { Hono } from "hono";
import { encryptBackupCredentials, zeroBuffer } from "./account-credentials-crypto.js";

export type AccountExportStores = {
  artifacts: Pick<ArtifactStore, "get">;
  home: Pick<AgentHomeStore, "exportHome">;
};

type ArchiveFile = { path: string; data: AsyncIterable<Uint8Array> | Iterable<Uint8Array> };

const encoder = new TextEncoder();
/** Records are batched into chunks about this size, so deflate is not fed one line at a time. */
const RECORD_CHUNK_BYTES = 64 * 1024;
/** Files go to deflate in slices this size, so the archive limit is checked between them. */
const FILE_SLICE_BYTES = 1024 * 1024;
/** fflate writes no Zip64 records, so an archive must stay under 4 GiB; this leaves headroom. */
export const ACCOUNT_EXPORT_MAX_ARCHIVE_BYTES = 2 ** 32 - 64 * 1024 * 1024;

/**
 * Streams a zip of `files` in order. Pull-based: the next file or chunk is read only when the
 * consumer wants more bytes, so at most one chunk of input is held in memory. Cancelling the
 * stream (a client abort) stops the file generator.
 */
export function zipStream(
  files: AsyncIterable<ArchiveFile>,
  maxBytes = ACCOUNT_EXPORT_MAX_ARCHIVE_BYTES,
): ReadableStream<Uint8Array> {
  const zip = new Zip();
  const output: Uint8Array[] = [];
  let finished = false;
  let failure: Error | null = null;
  let written = 0;
  zip.ondata = (error, chunk, final) => {
    if (error) failure = error;
    else {
      written += chunk.length;
      if (written > maxBytes) failure = new Error("Account export exceeds the zip size limit");
      if (chunk.length) output.push(chunk);
      if (final) finished = true;
    }
  };
  async function* steps(): AsyncGenerator<void> {
    for await (const file of files) {
      const entry = new ZipDeflate(file.path, { level: 6 });
      zip.add(entry);
      for await (const chunk of file.data) {
        for (let offset = 0; offset < chunk.length; offset += FILE_SLICE_BYTES) {
          entry.push(chunk.subarray(offset, offset + FILE_SLICE_BYTES));
          yield;
        }
      }
      entry.push(new Uint8Array(0), true);
      yield;
    }
    zip.end();
  }
  const producer = steps();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (!output.length && !finished) {
            const step = await producer.next();
            if (failure) throw failure;
            if (step.done && !finished) throw new Error("Zip ended without its last chunk");
          }
          if (failure) throw failure;
        } catch (error) {
          getLogger().error("account.export.failed", error);
          throw error;
        }
        for (const chunk of output.splice(0)) controller.enqueue(chunk);
        if (finished && !output.length) controller.close();
      },
      async cancel() {
        await producer.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

async function* jsonLines(records: AsyncIterable<AccountExportRecord>): AsyncGenerator<Uint8Array> {
  let batch = "";
  for await (const record of records) {
    batch += `${JSON.stringify(record)}\n`;
    if (batch.length >= RECORD_CHUNK_BYTES) {
      yield encoder.encode(batch);
      batch = "";
    }
  }
  if (batch) yield encoder.encode(batch);
}

/** manifest.json, then the encrypted credentials section, then per space its records, artifact bytes and bot workspace files. */
export async function* accountArchiveFiles(
  source: AccountExportSource,
  stores: AccountExportStores,
  options: {
    signal?: AbortSignal;
    now?: Date;
    /** The sealed `credentials.enc.json` entry, when the export carries credentials. */
    credentialsFile?: Uint8Array;
  } = {},
): AsyncGenerator<ArchiveFile> {
  const manifest: AccountExportManifest = {
    format: ACCOUNT_EXPORT_FORMAT,
    version: ACCOUNT_EXPORT_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    user: source.user,
    spaces: source.spaces.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
  };
  yield { path: ACCOUNT_EXPORT_MANIFEST_PATH, data: [encoder.encode(JSON.stringify(manifest))] };
  if (options.credentialsFile)
    yield { path: ACCOUNT_EXPORT_CREDENTIALS_PATH, data: [options.credentialsFile] };
  for (const space of source.spaces) {
    options.signal?.throwIfAborted();
    const tenant = { spaceId: space.id, userId: source.userId };
    const context = (botId?: string): AdapterContext => ({
      operationId: "account-export",
      traceId: "account-export",
      ...tenant,
      ...(botId ? { botId } : {}),
      signal: options.signal ?? new AbortController().signal,
    });
    yield { path: accountExportPaths.records(space.id), data: jsonLines(space.records()) };
    for await (const artifact of space.artifacts()) {
      let bytes: Uint8Array;
      try {
        bytes = await runAsTenant(tenant, () =>
          stores.artifacts.get(artifact.storageKey, context()),
        );
      } catch (error) {
        options.signal?.throwIfAborted();
        // One unreadable file should not cost the user the rest of their export.
        getLogger().warn("account.export.artifact_unreadable", {
          "artifact.id": artifact.id,
          "space.id": space.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      yield { path: accountExportPaths.artifact(space.id, artifact.id), data: [bytes] };
    }
    const executables: AccountExportExecutables = [];
    for (const home of await space.homes()) {
      const directory = resolveBotWorkspacePath(
        parseComputerMode(home.computerScope),
        home.botId,
        "",
      );
      const files = stores.home.exportHome(home.homeKey, context(home.botId), {
        directory,
        skipHidden: true,
      });
      for await (const file of runGeneratorAsTenant(tenant, iterate(files))) {
        if (file.content.length > ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES) {
          getLogger().warn("account.export.home_file_too_large", {
            "bot.id": home.botId,
            "space.id": space.id,
            size: file.content.length,
          });
          continue;
        }
        if (file.executable) executables.push({ botId: home.botId, path: file.path });
        yield {
          path: accountExportPaths.homeFile(space.id, home.botId, file.path),
          data: [file.content],
        };
      }
    }
    if (executables.length)
      yield {
        path: accountExportPaths.executables(space.id),
        data: [encoder.encode(JSON.stringify(executables))],
      };
  }
}

async function* iterate<T>(items: AsyncIterable<T>): AsyncGenerator<T> {
  yield* items;
}

export function accountExportFilename(now = new Date()): string {
  return `rakazo-export-${now.toISOString().slice(0, 10)}.zip`;
}

/**
 * The backup password's rules: long enough to stand alone, not breached, and not the
 * account's own password. The password arrives as a string (JSON cannot carry a buffer);
 * it is copied into a buffer at once, and the caller zeroes that buffer when done.
 */
async function validateBackupPassword(
  auth: Pick<Auth, "verifyAccountPassword" | "isPasswordBreached">,
  userId: string,
  password: Buffer,
): Promise<string | null> {
  if (password.length < ACCOUNT_EXPORT_BACKUP_PASSWORD_MIN_LENGTH)
    return `Backup password must be at least ${ACCOUNT_EXPORT_BACKUP_PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > 128) return "Backup password must be at most 128 characters.";
  let breached = false;
  try {
    // Fails open, like sign-up: an unreachable breach service must not block an export.
    breached = await auth.isPasswordBreached(password.toString("utf8"));
  } catch {
    breached = false;
  }
  if (breached) return "This backup password appeared in a data breach. Choose another.";
  if (await auth.verifyAccountPassword(userId, password.toString("utf8")))
    return "Backup password must differ from your account password.";
  return null;
}

/**
 * `POST /api/account/export` with a JSON body `{ token, backupPassword? }`. POST, not GET:
 * the backup password travels in the body of the same request that streams the archive, so
 * it never lands in a URL, a log, or a stored token. The one-time token from
 * `export.accountToken` — issued only after an identity confirmation — is still the gate.
 * Without a backup password the archive exports without a credentials section.
 */
export function mountAccountExportRoute(
  app: Hono,
  deps: AccountExportStores & {
    prisma: PrismaClient;
    secrets: SecretStore;
    auth: Pick<Auth, "consumeAccountExportToken" | "verifyAccountPassword" | "isPasswordBreached">;
  },
): void {
  app.post("/api/account/export", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.text("Send a JSON body with the export token.", 400, {
        "cache-control": "no-store",
      });
    }
    const token = (body as { token?: unknown; accountToken?: unknown } | null)?.token;
    const accountToken = (body as { accountToken?: unknown } | null)?.accountToken;
    const backupPassword = (body as { backupPassword?: unknown } | null)?.backupPassword;
    // The web client sends `token`, the mobile client `accountToken`; both name the same
    // one-time token.
    const tokenValue = typeof token === "string" ? token : accountToken;
    if (typeof tokenValue !== "string" || !tokenValue)
      return c.text("Export link expired", 410, { "cache-control": "no-store" });
    if (backupPassword !== undefined && typeof backupPassword !== "string")
      return c.text("Backup password must be a string.", 400, { "cache-control": "no-store" });
    const userId = await deps.auth.consumeAccountExportToken(tokenValue);
    // A link issued just before the account was deactivated no longer downloads it.
    if (!userId || (await accountDeactivated(deps.prisma, userId)))
      return c.text("Export link expired", 410, { "cache-control": "no-store" });
    // The password lives as a buffer from here on; the JSON string is left for the GC.
    const password = backupPassword === undefined ? null : Buffer.from(backupPassword, "utf8");
    let credentialsFile: Uint8Array | undefined;
    try {
      if (password) {
        const problem = await validateBackupPassword(deps.auth, userId, password);
        if (problem) return c.text(problem, 400, { "cache-control": "no-store" });
        const { credentials, unreadable } = await readAccountExportCredentials(
          deps.prisma,
          deps.secrets,
          userId,
        );
        const counts =
          credentials.model.length +
          credentials.voice.length +
          credentials.connections.length +
          credentials.mcp.length +
          credentials.vault.length +
          credentials.botSecrets.length;
        credentialsFile = await encryptBackupCredentials({ userId, password, credentials });
        await recordSecurityEvent({
          type: "account.export.credentials",
          userId,
          metadata: { credentials: counts, unreadable },
        });
      }
    } catch (error) {
      getLogger().error("account.export.credentials_failed", error);
      return c.text("The export failed.", 500, { "cache-control": "no-store" });
    } finally {
      if (password) zeroBuffer(password);
    }
    const now = new Date();
    const source = await readAccountExport(deps.prisma, userId);
    const bodyStream = zipStream(
      accountArchiveFiles(source, deps, {
        signal: c.req.raw.signal,
        now,
        credentialsFile,
      }),
    );
    return new Response(bodyStream, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${accountExportFilename(now)}"`,
        "cache-control": "no-store",
      },
    });
  });
}
