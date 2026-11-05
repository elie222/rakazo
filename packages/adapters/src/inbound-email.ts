import { createHash } from "node:crypto";
import type { Address } from "postal-mime";
import { htmlToPlainText } from "./keyless-http-web.js";

/** Largest raw message accepted, the size common mail relays deliver. */
export const INBOUND_EMAIL_MAX_BYTES = 25 * 1024 * 1024;

/** Body text handed to the bot; longer mail is cut here. */
export const INBOUND_EMAIL_TEXT_MAX_CHARS = 20_000;

/** DNS TXT lookups for DKIM keys; tests pass a fixed one. */
export type InboundEmailResolver = (
  domain: string,
  rrtype: string,
) => Promise<string[][] | string[]>;

export type InboundEmail = {
  /** Message-ID, or a hash of the raw message when it has none: the same message gets one key. */
  key: string;
  /** The single From mailbox, lowercased; null when the From field is missing or malformed. */
  from: { address: string; name: string } | null;
  /**
   * A DKIM signature that passed, aligns with the From domain and covers the one From, To and
   * Cc field, so the sender's domain vouches for the From address and the recipients.
   */
  authenticated: boolean;
  to: string[];
  cc: string[];
  subject: string;
  date: string | null;
  text: string;
  /** Auto-replies, bulk and mailing-list mail, which nothing should act on (RFC 3834). */
  automated: boolean;
  attachments: Array<{ name: string; mimeType: string; bytes: Uint8Array }>;
};

/** Parse a raw RFC 5322 message and check its DKIM signatures. */
export async function readInboundEmail(
  raw: Uint8Array,
  options: { resolver?: InboundEmailResolver } = {},
): Promise<InboundEmail> {
  // Loaded only on servers that receive email.
  const [{ default: PostalMime }, { dkimVerify }] = await Promise.all([
    import("postal-mime"),
    import("mailauth"),
  ]);
  const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const [email, dkim] = await Promise.all([
    PostalMime.parse(buffer, { attachmentEncoding: "arraybuffer" }),
    dkimVerify(buffer, options.resolver ? { resolver: options.resolver } : {}),
  ]);

  const fieldCount = (name: string) => email.headerLines.filter((line) => line.key === name).length;
  const header = (name: string) =>
    email.headers
      .find((line) => line.key === name)
      ?.value.trim()
      .toLowerCase() ?? "";

  const fromAddress =
    dkim.fromFields === 1 && dkim.fromSyntax === "valid" && dkim.headerFrom.length === 1
      ? (dkim.headerFrom[0]?.toLowerCase() ?? null)
      : null;
  const to = addresses(email.to);
  const cc = addresses(email.cc);
  // An extra To or Cc added above the signed one would be read but not verified.
  const singleFields = fieldCount("to") <= 1 && fieldCount("cc") <= 1;
  const authenticated =
    fromAddress !== null &&
    singleFields &&
    dkim.results.some((result) => {
      const status = result.status;
      if (status.result !== "pass" || !status.aligned) return false;
      // l= leaves trailing body bytes unsigned; anything could be appended there.
      if ((status.underSized ?? 0) > 0 || result.signatureTimeValid === false) return false;
      const signed = new Set(
        (result.signingHeaders?.keys ?? "").split(":").map((key) => key.trim().toLowerCase()),
      );
      return (
        signed.has("from") &&
        (fieldCount("to") === 0 || signed.has("to")) &&
        (fieldCount("cc") === 0 || signed.has("cc"))
      );
    });

  const precedence = header("precedence");
  const autoSubmitted = header("auto-submitted").split(";")[0]?.trim() ?? "";
  const automated =
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    precedence === "bulk" ||
    precedence === "junk" ||
    precedence === "list" ||
    fieldCount("list-id") > 0;

  const body = email.text?.trim() || (email.html ? htmlToPlainText(email.html) : "");
  const text =
    body.length > INBOUND_EMAIL_TEXT_MAX_CHARS
      ? `${body.slice(0, INBOUND_EMAIL_TEXT_MAX_CHARS)}\n[…]`
      : body;
  const fromName =
    email.from && !email.from.group && email.from.address?.toLowerCase() === fromAddress
      ? email.from.name
      : "";

  return {
    key:
      email.messageId?.trim() ||
      `sha256:${createHash("sha256").update(buffer).digest("base64url")}`,
    from: fromAddress ? { address: fromAddress, name: fromName } : null,
    authenticated,
    to,
    cc,
    subject: email.subject?.trim() ?? "",
    date: email.date ?? null,
    text,
    automated,
    attachments: email.attachments
      // Inline parts are images an HTML body shows, such as signature logos.
      .filter((attachment) => !attachment.related)
      .map((attachment) => ({
        name: attachment.filename?.trim() || "attachment",
        mimeType: attachment.mimeType,
        bytes:
          typeof attachment.content === "string"
            ? new TextEncoder().encode(attachment.content)
            : new Uint8Array(attachment.content),
      })),
  };
}

function addresses(list: Address[] | undefined): string[] {
  return (list ?? [])
    .flatMap((entry) => (entry.group ? entry.group : [entry]))
    .map((mailbox) => mailbox.address.trim().toLowerCase())
    .filter(Boolean);
}
