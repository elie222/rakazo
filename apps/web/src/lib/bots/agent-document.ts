import { AGENT_IMPORT_MAX_FILE_LENGTH } from "@rakazo/contracts";

/** Up to four UTF-8 bytes per allowed character. */
export const AGENT_DOCUMENT_MAX_BYTES = AGENT_IMPORT_MAX_FILE_LENGTH * 4;

/** Returns null when the file exceeds the byte or decoded length limit. */
export async function readAgentDocument(file: Pick<File, "size" | "text">): Promise<string | null> {
  if (file.size > AGENT_DOCUMENT_MAX_BYTES) return null;
  const text = await file.text();
  return text.length > AGENT_IMPORT_MAX_FILE_LENGTH ? null : text;
}
