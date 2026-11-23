import * as z from "zod";

export const BOT_WORKSPACE_PATH_MAX_LENGTH = 200;

/**
 * Where a bot's relative paths and command working directories start on its computer: a
 * slash-separated relative directory inside its workspace. Empty, absolute (a leading
 * `/`, `\`, `~` or a Windows drive) and `..`-containing values are invalid, so a stored
 * value can never escape the workspace outright. Returns the canonical form, or null
 * when the value is invalid.
 */
export function normalizeBotWorkspacePath(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > BOT_WORKSPACE_PATH_MAX_LENGTH) return null;
  if (/^(?:[~\\/]|[A-Za-z]:)/.test(value)) return null;
  // "." stays where it is, so "a/./b" means "a/b"; only ".." can leave the directory.
  const segments = value.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) return null;
  const normalized = segments.filter((segment) => segment !== ".").join("/");
  // "bots" is where a Team Computer keeps each bot's own folder, so a custom folder may not
  // point into another bot's.
  if (normalized === "bots" || normalized.startsWith("bots/")) return null;
  return normalized || null;
}

export const BotWorkspacePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(BOT_WORKSPACE_PATH_MAX_LENGTH)
  .refine((value) => normalizeBotWorkspacePath(value) !== null, {
    message: 'Use a relative folder path without ".." segments',
  })
  .transform((value) => normalizeBotWorkspacePath(value) ?? value);
