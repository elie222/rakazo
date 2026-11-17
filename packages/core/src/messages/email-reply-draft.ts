import { EMAIL_SEND_SUBJECT_MAX_CHARS } from "@rakazo/contracts";
import { ClientError } from "../primitives/client-error.js";
import { isServerUnreachable, isTechnicalErrorMessage } from "../primitives/user-error.js";

/**
 * A saved email draft is the copy of record. The reply card opens that draft,
 * and every edit is written back to it. Send delivers the draft as it stands
 * then, and only then is the draft sent. Discard leaves it unsent.
 */

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BODY_TOGGLE_LINES = 8;
const REFERENCE_LIMIT = 20;
const VERIFIED_REPLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type EmailReplyStatus = "ready" | "sent" | "discarded";
export type EmailReplyApproval = "needs_approval" | "send_once";

/** The draft as the card edits it. Address fields keep the exact text being typed. */
export type EmailReplyDraft = {
  id: string;
  from: string;
  inReplyTo: string;
  /** Once true, the In reply to row stays even when the field is cleared. */
  hasReplyTo: boolean;
  toText: string;
  ccText: string;
  subject: string;
  body: string;
  status: EmailReplyStatus;
  approval: EmailReplyApproval;
};

/** Field values as the card edits them. Address lists are the raw field text. */
export type EmailReplyEdit = {
  inReplyTo?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  approval?: EmailReplyApproval;
};

export type EmailReplyCardView = {
  draftId: string;
  title: "Mail";
  status: EmailReplyStatus;
  statusLabel: string;
  editable: boolean;
  from: string;
  inReplyTo: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  approval: EmailReplyApproval;
  showToggle: boolean;
  /** The reply row is only there when this draft answers a message. */
  showInReplyTo: boolean;
};

export type SentEmail = {
  draftId: string;
  from: string;
  inReplyTo: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
};

export type EmailReplyBlockSnapshot = {
  kind: "email_reply";
  draftId: string;
  from: string;
  inReplyTo?: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  status: EmailReplyStatus;
  approval?: EmailReplyApproval;
};

export class EmailReplyDraftError extends ClientError {
  constructor(message: string, code: string) {
    super("BAD_REQUEST", message, code);
    this.name = "EmailReplyDraftError";
  }
}

export function parseAddressList(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((address) => address.trim())
    .filter(Boolean);
}

function assertAddresses(addresses: string[]): void {
  if (addresses.some((address) => !ADDRESS.test(address))) {
    throw new EmailReplyDraftError("Check the email addresses", "EMAIL_REPLY_INVALID_ADDRESS");
  }
}

function statusLabel(status: EmailReplyStatus): string {
  if (status === "sent") return "Sent";
  if (status === "discarded") return "Discarded";
  return "Ready to send";
}

export function emailReplyCard(draft: EmailReplyDraft): EmailReplyCardView {
  return {
    draftId: draft.id,
    title: "Mail",
    status: draft.status,
    statusLabel: statusLabel(draft.status),
    editable: draft.status === "ready",
    from: draft.from,
    inReplyTo: draft.inReplyTo,
    to: draft.toText,
    cc: draft.ccText,
    subject: draft.subject,
    body: draft.body,
    approval: draft.approval,
    showToggle: draft.body.split(/\r?\n/).length > BODY_TOGGLE_LINES,
    showInReplyTo: draft.hasReplyTo || draft.inReplyTo.trim().length > 0,
  };
}

/** The thread-list line while the draft is waiting. */
export function emailReplyPreview(draft: Pick<EmailReplyDraft, "status" | "subject">): string {
  return draft.status === "ready" ? "The reply draft is ready…" : draft.subject;
}

function addressText(value: string[] | string | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

export function createEmailReplyDraft(input: {
  id: string;
  from: string;
  inReplyTo?: string;
  to: string[] | string;
  cc?: string[] | string;
  subject: string;
  body: string;
  approval?: EmailReplyApproval;
}): EmailReplyDraft {
  const from = input.from.trim();
  if (!from || !ADDRESS.test(from)) {
    throw new EmailReplyDraftError("The From address is invalid", "EMAIL_REPLY_INVALID_FROM");
  }
  const to = parseAddressList(addressText(input.to));
  const cc = parseAddressList(addressText(input.cc));
  assertAddresses([...to, ...cc]);
  const inReplyTo = input.inReplyTo?.trim() ?? "";
  return {
    id: input.id,
    from,
    inReplyTo,
    hasReplyTo: inReplyTo.length > 0,
    toText: addressText(input.to),
    ccText: addressText(input.cc),
    subject: input.subject,
    body: input.body,
    status: "ready",
    approval: input.approval ?? "needs_approval",
  };
}

export function applyEmailReplyEdit(draft: EmailReplyDraft, edit: EmailReplyEdit): EmailReplyDraft {
  if (draft.status !== "ready") {
    throw new EmailReplyDraftError("This draft is no longer editable", "EMAIL_REPLY_NOT_EDITABLE");
  }
  const inReplyTo = edit.inReplyTo === undefined ? draft.inReplyTo : edit.inReplyTo;
  return {
    ...draft,
    inReplyTo,
    hasReplyTo: draft.hasReplyTo || inReplyTo.trim().length > 0,
    toText: edit.to === undefined ? draft.toText : edit.to,
    ccText: edit.cc === undefined ? draft.ccText : edit.cc,
    subject: edit.subject === undefined ? draft.subject : edit.subject,
    body: edit.body === undefined ? draft.body : edit.body,
    approval: edit.approval ?? draft.approval,
  };
}

/** A subject safe to hand to a mail provider: one line, and no longer than the draft allows. */
export function emailReplySubjectLine(subject: string): string {
  return subject
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, EMAIL_SEND_SUBJECT_MAX_CHARS);
}

/** A message this draft may be answering, already loaded for this bot. */
export type EmailReplyParent = {
  messageId?: string | null;
  references: readonly string[];
  fromAddress: string;
  verified: boolean;
  sent: boolean;
  receivedAt: Date;
};

/**
 * Threading headers and the sender a reply may be addressed to. No parent means
 * this mail is not a reply. A reply that names a message has to load that message
 * before it sends; it does not go out as a new email.
 */
export function emailReplyThreading(
  parent: EmailReplyParent | null,
  domain: string,
  now = Date.now(),
): { headers?: Record<string, string>; verifiedReplySender?: string } {
  if (!parent) return {};
  const messageId = parent.messageId || undefined;
  const anchor = messageId ?? parent.references.at(-1);
  const references = messageId
    ? [...parent.references, messageId].slice(-REFERENCE_LIMIT)
    : [...parent.references];
  const headers = anchor ? { "In-Reply-To": anchor, References: references.join(" ") } : undefined;
  const senderDomain = parent.fromAddress.split("@").at(-1)?.toLowerCase();
  const recent = parent.receivedAt.getTime() >= now - VERIFIED_REPLY_WINDOW_MS;
  const verifiedReplySender =
    parent.verified && !parent.sent && recent && senderDomain !== domain.toLowerCase()
      ? parent.fromAddress
      : undefined;
  return {
    ...(headers ? { headers } : {}),
    ...(verifiedReplySender ? { verifiedReplySender } : {}),
  };
}

/** Fields a save stores. An unfinished address stays in the list so typing is not lost. */
export function emailReplySaveFields(draft: EmailReplyDraft) {
  return {
    inReplyTo: draft.inReplyTo,
    to: parseAddressList(draft.toText),
    cc: parseAddressList(draft.ccText),
    subject: draft.subject,
    body: draft.body,
    approval: draft.approval,
  };
}

export type EmailReplyWrite = ReturnType<typeof emailReplySaveFields>;

/** A save, a discard, or a send of the draft as the card currently shows it. */
export type EmailReplyCommitAction =
  | ({ type: "save" | "send" } & EmailReplyWrite)
  | { type: "discard" };

/** The message block a chat stores so the card can open this draft again. */
export function emailReplyBlock(draft: EmailReplyDraft): EmailReplyBlockSnapshot {
  const fields = emailReplySaveFields(draft);
  return {
    kind: "email_reply",
    draftId: draft.id,
    from: draft.from,
    ...(draft.hasReplyTo || fields.inReplyTo ? { inReplyTo: fields.inReplyTo } : {}),
    to: fields.to,
    cc: fields.cc,
    subject: fields.subject,
    body: fields.body,
    status: draft.status,
    approval: fields.approval,
  };
}

/**
 * Opens a stored block. A block the schema accepts always opens, even when an
 * address is not one this card would send.
 */
export function emailReplyDraftFromBlock(block: EmailReplyBlockSnapshot): EmailReplyDraft {
  return {
    id: block.draftId,
    from: block.from,
    inReplyTo: block.inReplyTo ?? "",
    hasReplyTo: block.inReplyTo !== undefined,
    toText: block.to.join(", "),
    ccText: block.cc.join(", "),
    subject: block.subject,
    body: block.body,
    status: block.status,
    approval: block.approval ?? "needs_approval",
  };
}

/** The message Send would deliver. Does not change the draft. */
export function emailReplyOutbound(draft: EmailReplyDraft): SentEmail {
  if (draft.status === "sent") {
    throw new EmailReplyDraftError("This draft was already sent", "EMAIL_REPLY_ALREADY_SENT");
  }
  if (draft.status === "discarded") {
    throw new EmailReplyDraftError("This draft was discarded", "EMAIL_REPLY_DISCARDED");
  }
  const to = parseAddressList(draft.toText);
  const cc = parseAddressList(draft.ccText);
  if (to.length === 0) {
    throw new EmailReplyDraftError("Add a recipient", "EMAIL_REPLY_NO_RECIPIENT");
  }
  assertAddresses([draft.from, ...to, ...cc]);
  if (!draft.subject.trim()) {
    throw new EmailReplyDraftError("Add a subject", "EMAIL_REPLY_NO_SUBJECT");
  }
  if (!draft.body.trim()) {
    throw new EmailReplyDraftError("Write the message", "EMAIL_REPLY_NO_BODY");
  }
  return {
    draftId: draft.id,
    from: draft.from,
    inReplyTo: draft.inReplyTo,
    to,
    cc,
    subject: draft.subject.trim(),
    body: draft.body,
  };
}

const MAIL_OFFLINE = "Could not reach the mail server.";

/**
 * A delivery failure written for a person. A technical failure is left undefined so the
 * caller logs it as a server error instead of replacing it with one fixed sentence.
 */
export function emailReplyDeliveryError(error: unknown): string | undefined {
  if (isServerUnreachable(error)) return MAIL_OFFLINE;
  const message = (
    error instanceof Error ? error.message : typeof error === "string" ? error : ""
  ).trim();
  if (!message || isTechnicalErrorMessage(message)) return undefined;
  return message;
}

export function emailReplyWithStatus(
  draft: EmailReplyDraft,
  status: EmailReplyStatus,
): EmailReplyDraft {
  return { ...draft, status };
}
