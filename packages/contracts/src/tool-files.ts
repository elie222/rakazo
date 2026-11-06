/**
 * Files that tools hand to other tools without their bytes passing through the model.
 *
 * A tool that produces a file (an MCP result with an image, audio or embedded resource, or a
 * stdio server writing into its Rakazo-managed output folder) gets the file stored as a
 * temporary file; the model sees a short mention instead of the content. The model passes the
 * file on by writing a placeholder in another tool's string argument, and Rakazo substitutes
 * the content (base64) or a short-lived signed download URL right before that tool runs.
 */

/** A temporary file is deleted this long after it was last created or used. */
export const TOOL_FILE_IDLE_TTL_MS = 3 * 60 * 60 * 1000;

/** A signed download URL for a temporary file stays valid this long. */
export const TOOL_FILE_URL_TTL_MS = 10 * 60 * 1000;
/** A signed download URL can be fetched this many times (a tool's retry gets a second try). */
export const TOOL_FILE_URL_MAX_USES = 3;

/** Placeholder replaced by the file's content, base64-encoded. */
export function toolFilePlaceholder(id: string): string {
  return `{{file:${id}}}`;
}

/** Placeholder replaced by a short-lived signed HTTPS URL that serves the file. */
export function toolFileUrlPlaceholder(id: string): string {
  return `{{file_url:${id}}}`;
}

/**
 * Placeholder replaced by the absolute path of a private copy of the file, for a local (stdio)
 * tool that reads a file from disk, such as an email attachment. The copy is deleted once the
 * call ends.
 */
export function toolFilePathPlaceholder(id: string): string {
  return `{{file_path:${id}}}`;
}

/** Matches every placeholder form; group 1 is `_url`, `_path` or empty, group 2 the file id. */
export const TOOL_FILE_PLACEHOLDER_PATTERN = /\{\{file(_url|_path)?:([A-Za-z0-9_-]{1,64})\}\}/g;

export type ToolFilePlaceholder = { id: string; form: "base64" | "url" | "path"; text: string };

/** Every placeholder in a string, in order of appearance. */
export function toolFilePlaceholders(value: string): ToolFilePlaceholder[] {
  return [...value.matchAll(TOOL_FILE_PLACEHOLDER_PATTERN)].map((match) => ({
    id: match[2] as string,
    form: match[1] === "_url" ? "url" : match[1] === "_path" ? "path" : "base64",
    text: match[0],
  }));
}

export type ToolFileMentionInput = { id: string; name: string; mimeType: string; size: number };

/** Human-readable size for mentions and approval cards. */
export function formatToolFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the model sees in place of a file's bytes. */
export function toolFileMention(file: ToolFileMentionInput): string {
  return (
    `[file "${file.name}" (${file.mimeType}, ${formatToolFileSize(file.size)}). ` +
    `To pass it to another tool, put ${toolFilePlaceholder(file.id)} where the tool expects ` +
    `base64 content, ${toolFileUrlPlaceholder(file.id)} where it expects a URL, or ` +
    `${toolFilePathPlaceholder(file.id)} where a local tool expects a file path.]`
  );
}
