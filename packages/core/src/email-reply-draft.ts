/**
 * A saved email draft is the copy of record. The reply card opens that draft,
 * and every edit is written back to it. Send delivers the draft as it stands
 * then. Discard leaves it unsent.
 */

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BODY_TOGGLE_LINES = 8;

export type EmailReplyStatus = "ready" | "sent" | "discarded";
export type EmailReplyApproval = "needs_approval" | "send_once";

export type EmailReplyDraft = {
  id: string;
  from: string;
  inReplyTo: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  status: EmailReplyStatus;
  approval: EmailReplyApproval;
};

/** Field values as the card edits them. Address lists are comma-separated. */
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
  title: "Reply";
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
    title: "Reply",
    status: draft.status,
    statusLabel: statusLabel(draft.status),
    editable: draft.status === "ready",
    from: draft.from,
    inReplyTo: draft.inReplyTo,
    to: draft.to.join(", "),
    cc: draft.cc.join(", "),
    subject: draft.subject,
    body: draft.body,
    approval: draft.approval,
    showToggle: draft.body.split(/\r?\n/).length > BODY_TOGGLE_LINES,
  };
}

/** The thread-list line while the draft is waiting. */
export function emailReplyPreview(draft: Pick<EmailReplyDraft, "status" | "subject">): string {
  return draft.status === "ready" ? "The reply draft is ready…" : draft.subject;
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
  const to = typeof input.to === "string" ? parseAddressList(input.to) : input.to.map((a) => a.trim());
  const cc = typeof input.cc === "string" ? parseAddressList(input.cc) : (input.cc ?? []).map((a) => a.trim());
  assertAddresses([...to, ...cc]);
  return {
    id: input.id,
    from,
    inReplyTo: input.inReplyTo?.trim() ?? "",
    to: to.filter(Boolean),
    cc: cc.filter(Boolean),
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
  const to = edit.to === undefined ? draft.to : parseAddressList(edit.to);
  const cc = edit.cc === undefined ? draft.cc : parseAddressList(edit.cc);
  assertAddresses([...to, ...cc]);
  return {
    ...draft,
    inReplyTo: edit.inReplyTo === undefined ? draft.inReplyTo : edit.inReplyTo,
    to,
    cc,
    subject: edit.subject === undefined ? draft.subject : edit.subject,
    body: edit.body === undefined ? draft.body : edit.body,
    approval: edit.approval ?? draft.approval,
  };
}

/** The message block a chat stores so the card can open this draft again. */
export function emailReplyBlock(draft: EmailReplyDraft) {
  return {
    kind: "email_reply" as const,
    draftId: draft.id,
    from: draft.from,
    inReplyTo: draft.inReplyTo,
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    body: draft.body,
    status: draft.status,
    approval: draft.approval,
  };
}

export function emailReplyDraftFromBlock(block: {
  draftId: string;
  from: string;
  inReplyTo?: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  status: EmailReplyStatus;
  approval?: EmailReplyApproval;
}): EmailReplyDraft {
  return {
    ...createEmailReplyDraft({
      id: block.draftId,
      from: block.from,
      inReplyTo: block.inReplyTo,
      to: block.to,
      cc: block.cc,
      subject: block.subject,
      body: block.body,
      approval: block.approval,
    }),
    status: block.status,
  };
}

export class EmailReplyDraftStore {
  private readonly drafts = new Map<string, EmailReplyDraft>();

  save(draft: EmailReplyDraft): EmailReplyCardView {
    this.drafts.set(draft.id, draft);
    return emailReplyCard(draft);
  }

  open(id: string): EmailReplyCardView {
    return emailReplyCard(this.require(id));
  }

  /** Writes the card edit onto the saved draft and returns the card. */
  edit(id: string, edit: EmailReplyEdit): EmailReplyCardView {
    const next = applyEmailReplyEdit(this.require(id), edit);
    this.drafts.set(id, next);
    return emailReplyCard(next);
  }

  get(id: string): EmailReplyDraft {
    return this.require(id);
  }

  send(id: string): SentEmail {
    const draft = this.require(id);
    if (draft.status !== "ready") {
      throw new EmailReplyDraftError(
        draft.status === "sent" ? "This draft was already sent" : "This draft was discarded",
      );
    }
    if (draft.to.length === 0) throw new EmailReplyDraftError("Add a recipient");
    if (!draft.subject.trim()) throw new EmailReplyDraftError("Add a subject");
    if (!draft.body.trim()) throw new EmailReplyDraftError("Write the message");
    const sent = { ...draft, status: "sent" as const };
    this.drafts.set(id, sent);
    return {
      draftId: sent.id,
      from: sent.from,
      inReplyTo: sent.inReplyTo,
      to: sent.to,
      cc: sent.cc,
      subject: sent.subject,
      body: sent.body,
    };
  }

  discard(id: string): EmailReplyDraft {
    const draft = this.require(id);
    if (draft.status === "sent") throw new EmailReplyDraftError("This draft was already sent");
    const discarded = { ...draft, status: "discarded" as const };
    this.drafts.set(id, discarded);
    return discarded;
  }

  private require(id: string): EmailReplyDraft {
    const draft = this.drafts.get(id);
    if (!draft) throw new EmailReplyDraftError("No draft with that id");
    return draft;
  }
}
