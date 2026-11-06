import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolFilePlaceholder } from "@rakazo/contracts";
import {
  formatToolFileSize,
  TOOL_FILE_PLACEHOLDER_PATTERN,
  toolFilePlaceholders,
} from "@rakazo/contracts";
import { mapStrings, safeFileName } from "./tool-file-capture.js";
import type { ToolFileScope, ToolFileStore } from "./tool-files.js";

/** One placeholder and what replaced it in the arguments a tool received. */
export type ToolFileSubstitution = {
  placeholder: string;
  form: ToolFilePlaceholder["form"];
  value: string;
};

/** Every distinct placeholder in any string inside `value`, including JSON-encoded strings. */
export function toolFilePlaceholdersIn(value: unknown): ToolFilePlaceholder[] {
  return [...placeholdersIn(value).values()];
}

function placeholdersIn(value: unknown, found = new Map<string, ToolFilePlaceholder>()) {
  if (typeof value === "string") {
    if (value.includes("{{file"))
      for (const placeholder of toolFilePlaceholders(value))
        found.set(placeholder.text, placeholder);
  } else if (Array.isArray(value)) for (const item of value) placeholdersIn(item, found);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) placeholdersIn(item, found);
  return found;
}

function replacePlaceholders(value: unknown, values: Map<string, string>): unknown {
  return mapStrings(value, (text) =>
    text.includes("{{file")
      ? text.replace(
          new RegExp(TOOL_FILE_PLACEHOLDER_PATTERN),
          (match) => values.get(match) ?? match,
        )
      : text,
  );
}

/** The tool error for a placeholder whose file cannot be used. */
export function unavailableToolFileError(placeholder: string): string {
  return `File ${placeholder} is not available (it may have expired)`;
}

/** The tool error for `{{file_path:ID}}` given to a tool that does not run on this server. */
export const LOCAL_FILE_PATH_UNSUPPORTED =
  "This tool cannot take a local file path; use {{file:ID}} or {{file_url:ID}}";

/**
 * Replace every `{{file:ID}}` with the file's content in base64 and every `{{file_url:ID}}`
 * with a short-lived signed URL, in a copy of `args` (the original keeps the placeholders, so
 * stored effects, approvals and audit never hold the content). A file that does not exist,
 * expired or belongs to another space, user or bot fails the whole call before the tool runs.
 * `{{file_path:ID}}` is left for the connector that runs the tool locally (see
 * {@link materializeToolFilePaths}) when `allowPaths`, and fails the call otherwise.
 */
export async function substituteToolFilePlaceholders(
  args: Record<string, unknown>,
  store: ToolFileStore | undefined,
  scope: ToolFileScope,
  options: { allowPaths?: boolean } = {},
): Promise<
  | { ok: true; args: Record<string, unknown>; substitutions: ToolFileSubstitution[] }
  | { ok: false; error: string }
> {
  const placeholders = [...placeholdersIn(args).values()];
  if (placeholders.length === 0) return { ok: true, args, substitutions: [] };
  if (!options.allowPaths && placeholders.some((placeholder) => placeholder.form === "path"))
    return { ok: false, error: LOCAL_FILE_PATH_UNSUPPORTED };
  const substitutions: ToolFileSubstitution[] = [];
  for (const placeholder of placeholders) {
    if (placeholder.form === "path") continue;
    if (!store) return { ok: false, error: unavailableToolFileError(placeholder.text) };
    try {
      const value =
        placeholder.form === "url"
          ? (await store.signedUrl(placeholder.id, scope)).url
          : Buffer.from((await store.read(placeholder.id, scope)).bytes).toString("base64");
      substitutions.push({ placeholder: placeholder.text, form: placeholder.form, value });
    } catch {
      return { ok: false, error: unavailableToolFileError(placeholder.text) };
    }
  }
  if (substitutions.length === 0) return { ok: true, args, substitutions };
  const values = new Map(substitutions.map((entry) => [entry.placeholder, entry.value]));
  return {
    ok: true,
    args: replacePlaceholders(args, values) as Record<string, unknown>,
    substitutions,
  };
}

/**
 * Replace every `{{file_path:ID}}` with the absolute path of a private copy of the file, under
 * `inputDir/<random>/<original name>` (attachments keep their real name). `cleanup` deletes the
 * copies; call it once the tool call ends, however it ends.
 */
export async function materializeToolFilePaths(
  args: Record<string, unknown>,
  store: ToolFileStore | undefined,
  scope: ToolFileScope,
  inputDir: string,
): Promise<
  | {
      ok: true;
      args: Record<string, unknown>;
      substitutions: ToolFileSubstitution[];
      cleanup: () => Promise<void>;
    }
  | { ok: false; error: string }
> {
  const placeholders = [...placeholdersIn(args).values()].filter(
    (placeholder) => placeholder.form === "path",
  );
  const dirs: string[] = [];
  const cleanup = async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
    );
  };
  if (placeholders.length === 0) return { ok: true, args, substitutions: [], cleanup };
  const substitutions: ToolFileSubstitution[] = [];
  for (const placeholder of placeholders) {
    let read: Awaited<ReturnType<ToolFileStore["read"]>>;
    try {
      if (!store) throw new Error("no tool file store");
      read = await store.read(placeholder.id, scope);
    } catch {
      await cleanup();
      return { ok: false, error: unavailableToolFileError(placeholder.text) };
    }
    try {
      const dir = await mkdtemp(join(inputDir, "f-"));
      dirs.push(dir);
      const path = join(dir, safeFileName(read.file.name, "file"));
      await writeFile(path, read.bytes, { mode: 0o600 });
      substitutions.push({ placeholder: placeholder.text, form: "path", value: path });
    } catch {
      await cleanup();
      return { ok: false, error: `File ${placeholder.text} could not be prepared for the tool` };
    }
  }
  const values = new Map(substitutions.map((entry) => [entry.placeholder, entry.value]));
  return {
    ok: true,
    args: replacePlaceholders(args, values) as Record<string, unknown>,
    substitutions,
    cleanup,
  };
}

/**
 * Put the placeholders back wherever a tool echoed the content or URL it was given, so neither
 * reaches the model, the stored result, logs or audit. Longest values first, so a URL that is
 * part of a longer value never splits it.
 */
export function restoreToolFilePlaceholders<T>(value: T, substitutions: ToolFileSubstitution[]): T {
  const usable = substitutions
    .filter((entry) => entry.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length);
  if (usable.length === 0) return value;
  return mapStrings(value, (text) =>
    usable.reduce(
      (current, entry) =>
        current.includes(entry.value)
          ? current.split(entry.value).join(entry.placeholder)
          : current,
      text,
    ),
  ) as T;
}

/**
 * Arguments as a person or reviewer reads them: each placeholder becomes `📎 name (size)`.
 * A file that cannot be described keeps its placeholder. Never reads file content.
 */
export async function readableToolFileArgs(
  args: Record<string, unknown>,
  store: ToolFileStore | undefined,
  scope: ToolFileScope,
): Promise<Record<string, unknown>> {
  const placeholders = [...placeholdersIn(args).values()];
  if (placeholders.length === 0 || !store) return args;
  const labels = new Map<string, string>();
  for (const placeholder of placeholders) {
    const file = await store.describe(placeholder.id, scope).catch(() => undefined);
    if (file) labels.set(placeholder.text, `📎 ${file.name} (${formatToolFileSize(file.size)})`);
  }
  if (labels.size === 0) return args;
  return replacePlaceholders(args, labels) as Record<string, unknown>;
}
