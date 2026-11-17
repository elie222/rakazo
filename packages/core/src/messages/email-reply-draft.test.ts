import { describe, expect, it } from "vitest";
import {
  applyEmailReplyEdit,
  createEmailReplyDraft,
  EmailReplyDraftError,
  emailReplyBlock,
  emailReplyCard,
  emailReplyDeliveryError,
  emailReplyDraftFromBlock,
  emailReplyOutbound,
  emailReplyPreview,
  emailReplyQuotedBody,
  emailReplySubjectLine,
  emailReplyThreading,
  emailReplyWithStatus,
} from "./email-reply-draft.js";

const original = {
  id: "draft-1",
  from: "ops@mail.example.com",
  inReplyTo: "message 12 in bookings@mail.example.com",
  to: ["clinic@example.com"],
  cc: ["name@example.com"],
  subject: "Re: Training enquiry",
  body: "Hi,\n\nThank you for getting in touch.\n",
};

describe("email reply drafts", () => {
  it("opens the saved draft as Mail", () => {
    const card = emailReplyCard(createEmailReplyDraft(original));
    expect(card.title).toBe("Mail");
    expect(card.statusLabel).toBe("Ready to send");
    expect(card.from).toBe(original.from);
    expect(card.inReplyTo).toBe(original.inReplyTo);
    expect(card.showInReplyTo).toBe(true);
    expect(card.to).toBe("clinic@example.com");
    expect(card.cc).toBe("name@example.com");
    expect(card.subject).toBe(original.subject);
    expect(card.editable).toBe(true);
    expect(emailReplyPreview(card)).toBe("The reply draft is ready…");
  });

  it("hides the reply row when the draft is not a reply", () => {
    const card = emailReplyCard(createEmailReplyDraft({ ...original, inReplyTo: "  " }));
    expect(card.showInReplyTo).toBe(false);
  });

  it("keeps the reply row after the reply line is cleared", () => {
    const cleared = applyEmailReplyEdit(createEmailReplyDraft(original), { inReplyTo: "" });
    expect(emailReplyCard(cleared).showInReplyTo).toBe(true);
    expect(emailReplyBlock(cleared).inReplyTo).toBe("");
  });

  it("keeps an unfinished address so the field can be typed", () => {
    const draft = applyEmailReplyEdit(createEmailReplyDraft(original), { to: "clinic@" });
    expect(emailReplyCard(draft).to).toBe("clinic@");
    expect(draft.toText).toBe("clinic@");
    expect(() => emailReplyOutbound(draft)).toThrow(/addresses/);
    expect(draft.status).toBe("ready");
  });

  it("describes the message to send without marking the draft sent", () => {
    const draft = applyEmailReplyEdit(
      applyEmailReplyEdit(createEmailReplyDraft(original), {
        subject: "Re: Training enquiry (revised)",
      }),
      { body: "Hi,\n\nThe course is one day.\n", to: "clinic@example.com, name@example.com" },
    );
    expect(draft.status).toBe("ready");
    const mail = emailReplyOutbound(draft);
    expect(mail.subject).toBe("Re: Training enquiry (revised)");
    expect(mail.body).toBe("Hi,\n\nThe course is one day.\n");
    expect(mail.to).toEqual(["clinic@example.com", "name@example.com"]);
    expect(draft.status).toBe("ready");

    const sent = emailReplyWithStatus(draft, "sent");
    expect(emailReplyCard(sent).statusLabel).toBe("Sent");
    expect(emailReplyCard(sent).editable).toBe(false);
    expect(() => applyEmailReplyEdit(sent, { subject: "again" })).toThrow(EmailReplyDraftError);
  });

  it("leaves a discarded draft unsent", () => {
    const edited = applyEmailReplyEdit(createEmailReplyDraft(original), { subject: "Do not send" });
    const discarded = emailReplyWithStatus(edited, "discarded");
    expect(discarded.status).toBe("discarded");
    expect(discarded.subject).toBe("Do not send");
    expect(() => emailReplyOutbound(discarded)).toThrow(/discarded/);
  });

  it("refuses to send a draft with no recipient", () => {
    const draft = applyEmailReplyEdit(createEmailReplyDraft(original), { to: "" });
    expect(() => emailReplyOutbound(draft)).toThrow(/recipient/);
    expect(draft.status).toBe("ready");
  });

  it("reopens a stored block, including one whose address would not send", () => {
    const draft = applyEmailReplyEdit(createEmailReplyDraft(original), { cc: "matt@example.com" });
    const block = emailReplyBlock(draft);
    const reopened = emailReplyDraftFromBlock(block);
    expect(reopened.ccText).toBe("matt@example.com");
    expect(emailReplyOutbound(reopened).cc).toEqual(["matt@example.com"]);

    const odd = emailReplyDraftFromBlock({ ...block, from: "not an address", to: ["clinic@"] });
    expect(odd.from).toBe("not an address");
    expect(odd.toText).toBe("clinic@");
    expect(() => emailReplyOutbound(odd)).toThrow(EmailReplyDraftError);
  });

  it("collapses line breaks in a subject before it can reach a mail provider", () => {
    expect(emailReplySubjectLine("Hello\r\nBcc: boss@example.com")).toBe(
      "Hello Bcc: boss@example.com",
    );
  });

  it("sets reply headers only for a real message, and trusts a verified sender", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const parent = {
      messageId: "<clinic@example.com>",
      references: ["<older@example.com>"],
      fromAddress: "clinic@example.com",
      verified: true,
      sent: false,
      receivedAt: new Date(now - 60_000),
    };
    expect(emailReplyThreading(null, "mail.example.com", now)).toEqual({});
    expect(emailReplyThreading(parent, "mail.example.com", now)).toEqual({
      headers: {
        "In-Reply-To": "<clinic@example.com>",
        References: "<older@example.com> <clinic@example.com>",
      },
      verifiedReplySender: "clinic@example.com",
    });
    expect(
      emailReplyThreading({ ...parent, sent: true }, "mail.example.com", now).verifiedReplySender,
    ).toBeUndefined();
    expect(
      emailReplyThreading(
        { ...parent, fromAddress: "ops@mail.example.com" },
        "mail.example.com",
        now,
      ).verifiedReplySender,
    ).toBeUndefined();
    expect(
      emailReplyThreading(
        { ...parent, receivedAt: new Date(now - 31 * 24 * 60 * 60 * 1000) },
        "mail.example.com",
        now,
      ).verifiedReplySender,
    ).toBeUndefined();
  });

  it("quotes the parent message under the reply", () => {
    const body = emailReplyQuotedBody("Thanks", {
      fromAddress: "clinic@example.com",
      fromName: "Clinic",
      text: "Can we book Friday?",
      receivedAt: new Date("2026-01-02T15:04:05.000Z"),
    });
    expect(body).toContain("Thanks");
    expect(body).toContain("Clinic <clinic@example.com> wrote:");
    expect(body).toContain("> Can we book Friday?");
  });

  it("keeps a mail failure a person can read and drops a technical one", () => {
    expect(emailReplyDeliveryError(new Error("Mailbox full"))).toBe("Mailbox full");
    expect(
      emailReplyDeliveryError(Object.assign(new Error("offline"), { code: "ECONNREFUSED" })),
    ).toBe("Could not reach the mail server.");
    expect(emailReplyDeliveryError(new Error("connect ECONNREFUSED 127.0.0.1:25"))).toBeUndefined();
  });
});
