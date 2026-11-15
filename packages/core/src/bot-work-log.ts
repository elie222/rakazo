import type { BotWorkLogEntry } from "@rakazo/contracts";
import { formatFileSize } from "./format-file-size.js";

/** What a work log row shows: the command or path, else the tool's name; a file's size; a failed command's exit code. */
export function workLogRow(entry: BotWorkLogEntry) {
  const { action } = entry;
  return {
    title: action?.command ?? entry.tool,
    size:
      action?.kind === "write_file" && action.bytes !== undefined
        ? formatFileSize(action.bytes)
        : null,
    exitCode: action?.exitCode || null,
  };
}
