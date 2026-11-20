import type { ComputerMode } from "@rakazo/contracts";

const COMPUTER_NAMES: Record<ComputerMode, string> = {
  team: "the Team Computer",
  dedicated: "your own computer",
};

/**
 * Told to a bot once, as a note in its thread, after it was moved to another computer.
 * `files` is absent when it had no files to bring.
 */
export function computerChangedNote(
  from: ComputerMode,
  to: ComputerMode,
  files?: "copied" | "stayed",
): string {
  const moved = `Your computer changed from ${COMPUTER_NAMES[from]} to ${COMPUTER_NAMES[to]}.`;
  if (files === "copied") return `${moved} Your files were copied over.`;
  if (files === "stayed") return `${moved} Your files stayed on ${COMPUTER_NAMES[from]}.`;
  return moved;
}
