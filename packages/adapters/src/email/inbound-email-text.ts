import { sliceWellFormed } from "@rakazo/core";
import { htmlTextWithOmissions } from "../providers/web/keyless-http/keyless-http-web.js";

export const INBOUND_EMAIL_TEXT_MAX_CHARS = 20_000;
const MAX_BODY_SCAN_CHARS = INBOUND_EMAIL_TEXT_MAX_CHARS * 10;
const SIGNATURE_SELECTOR =
  ".gmail_signature, .gmail_signature_prefix, [data-smartmail='gmail_signature'], [id='Signature'], [id='signature']";

function limitBody(text: string): string {
  return text.length > INBOUND_EMAIL_TEXT_MAX_CHARS
    ? `${sliceWellFormed(text, INBOUND_EMAIL_TEXT_MAX_CHARS)}\n[…]`
    : text;
}

export function inboundEmailBodyText(
  plainText: string | undefined,
  rawHtml: string | undefined,
): { text: string; modelText: string } {
  const plain = plainText?.trim();
  // The stored body and mail deduplication keep the original bounded text.
  if (plain) {
    return {
      text: limitBody(plain),
      modelText: limitBody(cleanPlainText(plain.slice(0, MAX_BODY_SCAN_CHARS))),
    };
  }
  if (!rawHtml) return { text: "", modelText: "" };
  const { text, filteredText } = htmlTextWithOmissions(
    rawHtml.slice(0, MAX_BODY_SCAN_CHARS),
    SIGNATURE_SELECTOR,
  );
  return { text: limitBody(text), modelText: limitBody(filteredText) };
}

function cleanPlainText(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  // A forwarded body can be the whole reason the mail reached the bot. Keep it even when
  // a signature comes before it or its lines are prefixed as a quote.
  const forward = lines.findIndex((line) =>
    /^(?:-+ Forwarded message -+|Begin forwarded message:|[-_]+ Original Message [-_]+)$/i.test(
      line.trim(),
    ),
  );
  const signature = lines.indexOf("-- ");
  if (signature > 0 && (forward === -1 || signature < forward)) {
    return [...lines.slice(0, signature), ...(forward === -1 ? [] : lines.slice(forward))]
      .join("\n")
      .trim();
  }

  // Strip only a trailing quoted reply with an attribution and a reply of its own above it.
  const lastUnquoted = lines.findLastIndex((line) => {
    const value = line.trim();
    return value.length > 0 && !value.startsWith(">");
  });
  if (
    forward === -1 &&
    lastUnquoted > 0 &&
    /^On .+ wrote:$/i.test(lines[lastUnquoted]?.trim() ?? "") &&
    lines.slice(lastUnquoted + 1).some((line) => line.trimStart().startsWith(">"))
  ) {
    return lines.slice(0, lastUnquoted).join("\n").trim();
  }
  return text.trim();
}
