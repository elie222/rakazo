import { AGENT_IMPORT_MAX_FILE_LENGTH } from "@rakazo/contracts";

/**
 * A chosen agent document is one uploaded file of at most this many characters, each up to
 * four UTF-8 bytes; a file larger than that is refused before it is read.
 */
export const AGENT_DOCUMENT_MAX_BYTES = AGENT_IMPORT_MAX_FILE_LENGTH * 4;

/** The document's text, or null when it is too large to import (then it is never read). */
export async function readAgentDocument(file: Pick<File, "size" | "text">): Promise<string | null> {
  if (file.size > AGENT_DOCUMENT_MAX_BYTES) return null;
  return file.text();
}
