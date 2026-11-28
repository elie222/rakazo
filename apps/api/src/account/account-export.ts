import type { AdapterContext, AgentHomeStore, ArtifactStore } from "@rakazo/adapter-kit";
import { ObjectStorageUnavailableError, resolveBotWorkspacePath } from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import type {
  AccountExportExecutables,
  AccountExportManifest,
  AccountExportRecord,
} from "@rakazo/contracts";
import {
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
  runAsTenant,
  runGeneratorAsTenant,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ZipInputFile } from "fflate";
import { Zip, ZipDeflate } from "fflate";
import type { Hono } from "hono";
import { isAccountHomePath } from "./account-home-path.js";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_CENTRAL_DIRECTORY_BYTES,
  withZip64EntryCount,
} from "./account-zip-format.js";

export type AccountExportStores = {
  artifacts: Pick<ArtifactStore, "get">;
  home: Pick<AgentHomeStore, "exportHome">;
};

type ArchiveFile = { path: string; data: AsyncIterable<Uint8Array> | Iterable<Uint8Array> };

const encoder = new TextEncoder();
/** Fixed-Huffman empty deflate stream, byte-identical to `ZipDeflate` for a zero-byte file. */
const EMPTY_DEFLATE_BLOCK = new Uint8Array([0x03, 0x00]);
/** Records are batched into chunks about this size, so deflate is not fed one line at a time. */
const RECORD_CHUNK_BYTES = 64 * 1024;
/** Files go to deflate in slices this size, so the archive limit is checked between them. */
const FILE_SLICE_BYTES = 1024 * 1024;
/** Keep file offsets and sizes within 32 bits. The ZIP64 footer extends only the entry count. */
export const ACCOUNT_EXPORT_MAX_ARCHIVE_BYTES = 2 ** 32 - 64 * 1024 * 1024;

/**
 * Streams a zip of `files` in order. Pull-based: the next file or chunk is read only when the
 * consumer wants more bytes, so at most one chunk of input is held in memory. Cancelling the
 * stream or aborting `signal` (a client disconnect) stops the file generator and is not an error.
 */
export function zipStream(
  files: AsyncIterable<ArchiveFile>,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const maxBytes = options.maxBytes ?? ACCOUNT_EXPORT_MAX_ARCHIVE_BYTES;
  const zip = new Zip();
  const output: Uint8Array[] = [];
  let outputBytes = 0;
  let finished = false;
  let failure: Error | null = null;
  let written = 0;
  let entries = 0;
  let directoryBytes = 0;
  zip.ondata = (error, chunk, final) => {
    if (error) failure = error;
    else {
      const bytes = final ? withZip64EntryCount(chunk, entries) : chunk;
      written += bytes.length;
      if (written > maxBytes) failure = new Error("Account export exceeds the zip size limit");
      if (bytes.length) {
        output.push(bytes);
        outputBytes += bytes.length;
      }
      if (final) finished = true;
    }
  };
  async function* steps(): AsyncGenerator<void> {
    for await (const file of files) {
      entries++;
      // The writer adds a 46-byte directory header and a UTF-8 name per entry.
      directoryBytes += 46 + Buffer.byteLength(file.path);
      if (entries > MAX_ARCHIVE_ENTRIES || directoryBytes > MAX_CENTRAL_DIRECTORY_BYTES)
        throw new Error("Account export has too many files or file names that are too long");
      let fileBytes = 0;
      let entry: ZipDeflate | undefined;
      for await (const chunk of file.data) {
        if (!chunk.length) continue;
        fileBytes += chunk.length;
        if (fileBytes >= 0xffffffff) throw new Error("A file exceeds the export ZIP size limit");
        if (!entry) {
          entry = new ZipDeflate(file.path, { level: 6 });
          zip.add(entry);
        }
        for (let offset = 0; offset < chunk.length; offset += FILE_SLICE_BYTES) {
          entry.push(chunk.subarray(offset, offset + FILE_SLICE_BYTES));
          yield;
        }
      }
      if (entry) {
        entry.push(new Uint8Array(0), true);
      } else {
        // Emit the empty deflate block without allocating a deflate window per empty entry.
        const empty: ZipInputFile = {
          filename: file.path,
          compression: 8,
          flag: 0,
          size: 0,
          crc: 0,
        };
        zip.add(empty);
        empty.ondata?.(null, EMPTY_DEFLATE_BLOCK, true);
      }
      yield;
    }
    zip.end();
  }
  const producer = steps();
  let cancelled = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (!output.length && !finished) {
            const step = await producer.next();
            // A cancel during this read ends the producer early; the client is gone.
            if (cancelled) return;
            if (failure) throw failure;
            if (step.done && !finished) throw new Error("Zip ended without its last chunk");
          }
          if (failure) throw failure;
        } catch (error) {
          if (error === failure || (!cancelled && !options.signal?.aborted)) {
            // An outage was already logged as a warning where the store failed.
            if (!(error instanceof ObjectStorageUnavailableError))
              getLogger().error("account.export.failed", error);
            throw error;
          }
          getLogger().warn("account.export.aborted", {
            error: error instanceof Error ? error.message : String(error),
          });
          if (cancelled) return;
          throw error;
        }
        if (output.length === 1) {
          controller.enqueue(output[0]!);
        } else if (output.length > 1) {
          const merged = new Uint8Array(outputBytes);
          let offset = 0;
          for (const chunk of output) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          controller.enqueue(merged);
        }
        output.length = 0;
        outputBytes = 0;
        if (finished) controller.close();
      },
      async cancel() {
        cancelled = true;
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

/** manifest.json, then per space its records, artifact bytes and bot workspace files. */
export async function* accountArchiveFiles(
  source: AccountExportSource,
  stores: AccountExportStores,
  options: { signal?: AbortSignal; now?: Date } = {},
): AsyncGenerator<ArchiveFile> {
  const manifest: AccountExportManifest = {
    format: ACCOUNT_EXPORT_FORMAT,
    version: ACCOUNT_EXPORT_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    user: source.user,
    spaces: source.spaces.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
  };
  yield { path: ACCOUNT_EXPORT_MANIFEST_PATH, data: [encoder.encode(JSON.stringify(manifest))] };
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
        if (error instanceof ObjectStorageUnavailableError) throw error;
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
        maxFileBytes: ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES,
        onOversizedFile: (sizeAtLeast) =>
          getLogger().warn("account.export.home_file_too_large", {
            "bot.id": home.botId,
            "space.id": space.id,
            sizeAtLeast,
          }),
      });
      for await (const file of runGeneratorAsTenant(tenant, iterate(files))) {
        if (!isAccountHomePath(file.path)) {
          getLogger().warn("account.export.home_path_unsupported", {
            "bot.id": home.botId,
            "space.id": space.id,
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
 * `GET /api/account/export?token=`: a plain navigation, so the browser or Electron saves the
 * download itself. The one-time token from `export.accountToken` is the only credential.
 */
export function mountAccountExportRoute(
  app: Hono,
  deps: AccountExportStores & {
    prisma: PrismaClient;
    auth: Pick<Auth, "consumeAccountExportToken">;
  },
): void {
  app.get("/api/account/export", async (c) => {
    const userId = await deps.auth.consumeAccountExportToken(c.req.query("token") ?? "");
    // A link issued just before the account was deactivated no longer downloads it.
    if (!userId || (await accountDeactivated(deps.prisma, userId)))
      return c.text("Export link expired", 410, { "cache-control": "no-store" });
    const now = new Date();
    const source = await readAccountExport(deps.prisma, userId);
    const signal = c.req.raw.signal;
    const body = zipStream(accountArchiveFiles(source, deps, { signal, now }), { signal });
    return new Response(body, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${accountExportFilename(now)}"`,
        "cache-control": "no-store",
      },
    });
  });
}
