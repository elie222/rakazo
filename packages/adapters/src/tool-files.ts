import type { ToolFileMentionInput } from "@rakazo/contracts";

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
