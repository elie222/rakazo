/**
 * A saved email draft is the copy of record. The reply card opens that draft,
 * and every edit is written back to it. Send delivers the draft as it stands
 * then, and only then is the draft sent. Discard leaves it unsent.
 */

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BODY_TOGGLE_LINES = 8;
const SUBJECT_MAX = 500;
const REFERENCE_LIMIT = 20;
const VERIFIED_REPLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type EmailReplyStatus = "ready" | "sent" | "discarded";
export type EmailReplyApproval = "needs_approval" | "send_once";

/** The draft as the card edits it. Address fields keep the exact text being typed. */
export type EmailReplyDraft = {
  id: string;
  from: string;
  inReplyTo: string;
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

export class EmailReplyDraftError extends Error {
  constructor(message: string) {
    super(message);
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
    throw new EmailReplyDraftError("Check the email addresses");
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
    showInReplyTo: draft.inReplyTo.trim().length > 0,
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
  if (!from || !ADDRESS.test(from)) throw new EmailReplyDraftError("The From address is invalid");
  const to = parseAddressList(addressText(input.to));
  const cc = parseAddressList(addressText(input.cc));
  assertAddresses([...to, ...cc]);
  return {
    id: input.id,
    from,
    inReplyTo: input.inReplyTo?.trim() ?? "",
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
    throw new EmailReplyDraftError("This draft is no longer editable");
  }
  return {
    ...draft,
    inReplyTo: edit.inReplyTo === undefined ? draft.inReplyTo : edit.inReplyTo,
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
    .slice(0, SUBJECT_MAX);
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
 * Threading headers and the sender a reply may be addressed to. A draft whose
 * reply line is only a label has no parent, so it sends as a new message.
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
    ...(fields.inReplyTo ? { inReplyTo: fields.inReplyTo } : {}),
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
  if (draft.status === "sent") throw new EmailReplyDraftError("This draft was already sent");
  if (draft.status === "discarded") throw new EmailReplyDraftError("This draft was discarded");
  const to = parseAddressList(draft.toText);
  const cc = parseAddressList(draft.ccText);
  if (to.length === 0) throw new EmailReplyDraftError("Add a recipient");
  assertAddresses([draft.from, ...to, ...cc]);
  if (!draft.subject.trim()) throw new EmailReplyDraftError("Add a subject");
  if (!draft.body.trim()) throw new EmailReplyDraftError("Write the message");
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

export function emailReplyWithStatus(
  draft: EmailReplyDraft,
  status: EmailReplyStatus,
): EmailReplyDraft {
  return { ...draft, status };
}
