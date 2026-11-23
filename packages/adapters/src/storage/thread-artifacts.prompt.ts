import type { MaterializedThreadFile } from "./thread-artifacts.js";

function fileLine(file: MaterializedThreadFile): string {
  return `- ${JSON.stringify(file.name)} (${file.mimeType}, ${file.size} bytes): ${JSON.stringify(file.path)}`;
}

export function currentTurnFilesInstruction(files: readonly MaterializedThreadFile[]): string {
  if (!files.length) return "";
  return [
    "Attachments will be copied to these paths when a tool needs the computer. If an image is visible directly in your input, answer from that image without starting the computer. Inspect files not visible in your input with file tools before answering questions about their contents:",
    ...files.map(fileLine),
  ].join("\n");
}

export function recentThreadFilesInstruction(files: readonly MaterializedThreadFile[]): string {
  if (!files.length) return "";
  return [
    "Files attached earlier in this conversation are also on your computer:",
    ...files.map(fileLine),
  ].join("\n");
}
