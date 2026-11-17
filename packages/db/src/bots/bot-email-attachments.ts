import { z } from "zod";
import { readJsonColumn } from "../database/json-column.js";

const EmailAttachments = z.array(
  z.union([
    z.object({
      name: z.string(),
      artifactId: z.string(),
      mimeType: z.string(),
      size: z.number(),
    }),
    // Named only. A kept file in another shape must not read as this one: the inbox would store
    // the files again and write them over the row.
    z.object({ name: z.string(), artifactId: z.undefined().optional() }),
  ]),
);
/** A file an email carried: its name, and the kept artifact when the sender earned one. */
export type EmailAttachment = { name: string } & (
  | { artifactId: string; mimeType: string; size: number }
  | { artifactId?: undefined; mimeType?: undefined; size?: undefined }
);

/** A saved email's files, or none (with a warning) when the row holds something else. */
export function storedEmailAttachments(email: {
  id: string;
  attachments: unknown;
}): EmailAttachment[] {
  return readJsonColumn(
    EmailAttachments,
    email.attachments,
    { table: "bot_email_messages", column: "attachments", id: email.id },
    { fallback: [] },
  );
}
