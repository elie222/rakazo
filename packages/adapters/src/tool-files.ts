import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { ToolFileMentionInput } from "@rakazo/contracts";
import {
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
  attachmentSizeLabel,
  TOOL_FILE_IDLE_TTL_MS,
  TOOL_FILE_URL_MAX_USES,
  TOOL_FILE_URL_TTL_MS,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createRetentionPruner, runAsSystem, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** Who may use a temporary tool file: the space, user and bot that produced it. */
export type ToolFileScope = { spaceId: string; userId: string; botId?: string | null };

/** A stored temporary file; `id` is what placeholders carry. */
export type ToolFileRef = ToolFileMentionInput & { expiresAt: Date };

/**
 * Temporary files that tools hand to other tools (see `@rakazo/contracts` tool-files).
 * Every file expires `TOOL_FILE_IDLE_TTL_MS` after it was created or last used, and a sweep
 * deletes expired ones from storage and the database.
 */
export interface ToolFileStore {
  /** Store bytes a tool produced. */
  create(
    input: ToolFileScope & {
      runId?: string | null;
      name: string;
      mimeType: string;
      bytes: Uint8Array;
    },
  ): Promise<ToolFileRef>;
  /** Read a file for substitution into a tool argument; extends its expiry. Throws when
   * the file does not exist, expired, or belongs to another space, user or bot. */
  read(id: string, scope: ToolFileScope): Promise<{ file: ToolFileRef; bytes: Uint8Array }>;
  /** Mint a short-lived signed HTTPS download URL; extends the file's expiry. Same checks as `read`. */
  signedUrl(id: string, scope: ToolFileScope): Promise<{ file: ToolFileRef; url: string }>;
  /** Metadata only, for approval cards; no expiry change. Undefined when not usable in scope. */
  describe(id: string, scope: ToolFileScope): Promise<ToolFileRef | undefined>;
  /** Delete every expired file; returns how many were removed. */
  sweepExpired(now?: Date): Promise<number>;
}

/** Where the API serves a signed download: `${publicBaseUrl}${TOOL_FILE_DOWNLOAD_PATH}<token>`. */
export const TOOL_FILE_DOWNLOAD_PATH = "/api/tool-files/";

/** The same message whether the file never existed, expired, or belongs to someone else. */
export class ToolFileNotFoundError extends Error {
  constructor() {
    super("The file is not available; it may have expired");
    this.name = "ToolFileNotFoundError";
  }
}

export class ToolFileTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`The file exceeds the ${attachmentSizeLabel(maxBytes)} limit for files tools hand on`);
    this.name = "ToolFileTooLargeError";
  }
}

// A sweep claims an expired file by moving its expiry here, which no use can extend again,
// before it deletes the bytes; the row goes last, so a failed delete is retried next sweep.
const CLAIMED = new Date(0);
const SWEEP_BATCH = 100;
// 32 random bytes, base64url without padding.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const FALLBACK_MIME_TYPE = "application/octet-stream";

type ToolFileRow = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string | null;
  runId: string | null;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  expiresAt: Date | null;
};

const ROW_SELECT = {
  id: true,
  spaceId: true,
  userId: true,
  botId: true,
  runId: true,
  name: true,
  mimeType: true,
  size: true,
  storageKey: true,
  expiresAt: true,
} as const;

export type ToolFileStoreDeps = {
  prisma: PrismaClient;
  /** Bytes go through the deployment's artifact store, so they are encrypted at rest like any file. */
  artifacts: ArtifactStore;
  /** Origin the API is reached at (`API_URL`); signed download URLs start with it. */
  publicBaseUrl: string;
  /** Largest file a tool may hand on; defaults to the attachment upload limit. */
  maxBytes?: number;
  now?: () => Date;
};

export function hashToolFileToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Temporary tool files as artifacts with an expiry. Uses run as the file's tenant (spaceId and
 * userId), so row-level security keeps them in their Space; the sweep and the public download,
 * which start from no tenant, are named system steps.
 */
export class PrismaToolFileStore implements ToolFileStore {
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly baseUrl: string;

  constructor(private readonly deps: ToolFileStoreDeps) {
    this.maxBytes = deps.maxBytes ?? ATTACHMENT_MAX_BYTES;
    this.now = deps.now ?? (() => new Date());
    this.baseUrl = deps.publicBaseUrl.replace(/\/+$/, "");
  }

  async create(
    input: ToolFileScope & {
      runId?: string | null;
      name: string;
      mimeType: string;
      bytes: Uint8Array;
    },
  ): Promise<ToolFileRef> {
    if (input.bytes.byteLength > this.maxBytes) throw new ToolFileTooLargeError(this.maxBytes);
    const name = toolFileName(input.name);
    const mimeType = toolFileMimeType(input.mimeType);
    const context = adapterContext(input, "create");
    const stored = await this.deps.artifacts.put({ name, mimeType, bytes: input.bytes }, context);
    const hash = createHash("sha256").update(input.bytes).digest("hex");
    try {
      const row = await runAsTenant(input, () =>
        this.deps.prisma.artifact.create({
          data: {
            spaceId: input.spaceId,
            userId: input.userId,
            botId: input.botId ?? null,
            runId: input.runId ?? null,
            name,
            mimeType,
            size: input.bytes.byteLength,
            hash,
            storageKey: stored.id,
            expiresAt: new Date(this.now().getTime() + TOOL_FILE_IDLE_TTL_MS),
          },
          select: ROW_SELECT,
        }),
      );
      return toolFileRef(row);
    } catch (error) {
      await this.deps.artifacts.remove(stored.id, context).catch(() => undefined);
      throw error;
    }
  }

  async read(id: string, scope: ToolFileScope) {
    const row = await this.touch(id, scope);
    const bytes = await this.deps.artifacts.get(row.storageKey, adapterContext(row, "read"));
    return { file: toolFileRef(row), bytes };
  }

  async signedUrl(id: string, scope: ToolFileScope) {
    const row = await this.touch(id, scope);
    const token = randomBytes(32).toString("base64url");
    await runAsTenant(scope, () =>
      this.deps.prisma.toolFileDownloadToken.create({
        data: {
          tokenHash: hashToolFileToken(token),
          artifactId: row.id,
          spaceId: row.spaceId,
          expiresAt: new Date(this.now().getTime() + TOOL_FILE_URL_TTL_MS),
          usesLeft: TOOL_FILE_URL_MAX_USES,
        },
      }),
    );
    return { file: toolFileRef(row), url: `${this.baseUrl}${TOOL_FILE_DOWNLOAD_PATH}${token}` };
  }

  async describe(id: string, scope: ToolFileScope) {
    const row = await this.find(id, scope, this.now());
    return row ? toolFileRef(row) : undefined;
  }

  /**
   * Serves a signed download link: one use of an unexpired token, for a file that has not
   * expired, which the use keeps alive. Undefined for every token that does not qualify.
   */
  async download(token: string): Promise<{ file: ToolFileRef; bytes: Uint8Array } | undefined> {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const now = this.now();
    const row = await runAsSystem("tool file download link", async () => {
      const [redeemed] = await this.deps.prisma.$queryRaw<Array<{ artifactId: string }>>`
        UPDATE "tool_file_download_tokens" SET "usesLeft" = "usesLeft" - 1
        WHERE "tokenHash" = ${hashToolFileToken(token)} AND "usesLeft" > 0 AND "expiresAt" > ${now}
        RETURNING "artifactId"`;
      if (!redeemed) return undefined;
      const file = await this.deps.prisma.artifact.findFirst({
        where: { id: redeemed.artifactId, expiresAt: { gt: now } },
        select: ROW_SELECT,
      });
      if (!file) return undefined;
      return (await this.extend(file.id, now)) ?? undefined;
    });
    if (!row) return undefined;
    const bytes = await this.deps.artifacts.get(row.storageKey, adapterContext(row, "download"));
    return { file: toolFileRef(row), bytes };
  }

  async sweepExpired(now: Date = this.now()): Promise<number> {
    return runAsSystem("sweep expired temporary tool files", async () => {
      const { prisma, artifacts } = this.deps;
      let removed = 0;
      // Rows a sweep keeps (their bytes would not delete) are not picked again in this pass.
      const kept = new Set<string>();
      for (;;) {
        const candidates = await prisma.artifact.findMany({
          where: { expiresAt: { lte: now }, id: { notIn: [...kept] } },
          orderBy: { expiresAt: "asc" },
          take: SWEEP_BATCH,
          select: { id: true },
        });
        if (!candidates.length) break;
        const ids = candidates.map((row) => row.id);
        await prisma.artifact.updateMany({
          where: { id: { in: ids }, expiresAt: { lte: now } },
          data: { expiresAt: CLAIMED },
        });
        const claimed = await prisma.artifact.findMany({
          where: { id: { in: ids }, expiresAt: CLAIMED },
          select: ROW_SELECT,
        });
        const gone: string[] = [];
        for (const row of claimed) {
          try {
            await artifacts.remove(row.storageKey, adapterContext(row, "sweep"));
            gone.push(row.id);
          } catch (error) {
            kept.add(row.id);
            getLogger().warn("tool.file.sweep.remove_failed", {
              "artifact.id": row.id,
              "error.message": error instanceof Error ? error.message : String(error),
            });
          }
        }
        // Another sweep may have removed some of these already; count only what this one did.
        const { count } = await prisma.artifact.deleteMany({
          where: { id: { in: gone }, expiresAt: CLAIMED },
        });
        removed += count;
        if (candidates.length < SWEEP_BATCH) break;
      }
      await prisma.toolFileDownloadToken.deleteMany({
        where: { OR: [{ expiresAt: { lte: now } }, { usesLeft: { lte: 0 } }] },
      });
      return removed;
    });
  }

  /** The file, when it is a live temporary file in this scope. */
  private async find(id: string, scope: ToolFileScope, now: Date) {
    const row = await runAsTenant(scope, () =>
      this.deps.prisma.artifact.findFirst({
        where: {
          id,
          spaceId: scope.spaceId,
          userId: scope.userId,
          expiresAt: { gt: now },
        },
        select: ROW_SELECT,
      }),
    );
    if (!row) return undefined;
    if (row.botId && scope.botId && row.botId !== scope.botId) return undefined;
    return row;
  }

  /** `find`, then push the expiry back; throws when the file is not usable in scope. */
  private async touch(id: string, scope: ToolFileScope) {
    const now = this.now();
    const row = await this.find(id, scope, now);
    const extended = row && (await runAsTenant(scope, () => this.extend(row.id, now)));
    if (!extended) throw new ToolFileNotFoundError();
    return extended;
  }

  /** A use keeps the file another full idle period; an expired one stays expired. */
  private async extend(id: string, now: Date) {
    const expiresAt = new Date(now.getTime() + TOOL_FILE_IDLE_TTL_MS);
    const { count } = await this.deps.prisma.artifact.updateMany({
      where: { id, expiresAt: { gt: now } },
      data: { expiresAt },
    });
    if (count === 0) return undefined;
    return this.deps.prisma.artifact.findFirst({ where: { id }, select: ROW_SELECT });
  }
}

export function createToolFileStore(deps: ToolFileStoreDeps): PrismaToolFileStore {
  return new PrismaToolFileStore(deps);
}

/** How often the reconciler deletes expired temporary files. */
export const TOOL_FILE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** The reconciler's sweep: expired temporary files every ten minutes, logging how many went. */
export function toolFileSweeper(
  store: Pick<ToolFileStore, "sweepExpired">,
  options: { intervalMs?: number; now?: () => Date } = {},
): () => Promise<void> {
  return createRetentionPruner("tool.file", (at) => store.sweepExpired(at), {
    intervalMs: TOOL_FILE_SWEEP_INTERVAL_MS,
    ...options,
  });
}

function toolFileRef(row: ToolFileRow): ToolFileRef {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    expiresAt: row.expiresAt ?? CLAIMED,
  };
}

function adapterContext(
  row: { spaceId: string; userId: string; botId?: string | null; runId?: string | null },
  operation: string,
): AdapterContext {
  const operationId = `tool-file.${operation}`;
  return {
    operationId,
    traceId: operationId,
    spaceId: row.spaceId,
    userId: row.userId,
    ...(row.botId ? { botId: row.botId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    signal: new AbortController().signal,
  };
}

/** A plain file name: no folders, no control characters, within the artifact name limit. */
export function toolFileName(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, "/"));
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (clean && clean !== "." && clean !== ".." ? clean : "file").slice(
    0,
    ARTIFACT_NAME_MAX_LENGTH,
  );
}

/** The type the download is served with: a bare `type/subtype`, or octet-stream. */
export function toolFileMimeType(mimeType: string): string {
  const bare = mimeType.split(";")[0]!.trim().toLowerCase();
  return MIME_TYPE_PATTERN.test(bare) ? bare : FALLBACK_MIME_TYPE;
}
