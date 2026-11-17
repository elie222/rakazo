import { describe, expect, it } from "vitest";
import {
  createEmailReplyDraft,
  EmailReplyDraftError,
  EmailReplyDraftStore,
  emailReplyBlock,
  emailReplyDraftFromBlock,
  emailReplyOutbound,
  emailReplyPreview,
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
    const store = new EmailReplyDraftStore();
    const card = store.save(createEmailReplyDraft(original));
    expect(card.title).toBe("Mail");
    expect(card.statusLabel).toBe("Ready to send");
    expect(card.from).toBe(original.from);
    expect(card.inReplyTo).toBe(original.inReplyTo);
    expect(card.to).toBe("clinic@example.com");
    expect(card.cc).toBe("name@example.com");
    expect(card.subject).toBe(original.subject);
    expect(card.editable).toBe(true);
    expect(emailReplyPreview(store.get(card.draftId))).toBe("The reply draft is ready…");
  });

  it("keeps an unfinished address so the field can be typed", () => {
    const store = new EmailReplyDraftStore();
    store.save(createEmailReplyDraft(original));
    const card = store.edit("draft-1", { to: "clinic@" });
    expect(card.to).toBe("clinic@");
    expect(store.get("draft-1").toText).toBe("clinic@");
    expect(() => emailReplyOutbound(store.get("draft-1"))).toThrow(/addresses/);
    expect(store.get("draft-1").status).toBe("ready");
  });

  it("sends the text the card shows, and only after delivery", async () => {
    const store = new EmailReplyDraftStore();
    store.save(createEmailReplyDraft(original));
    store.edit("draft-1", { subject: "Re: Training enquiry (revised)" });
    store.edit("draft-1", {
      body: "Hi,\n\nThe course is one day.\n",
      to: "clinic@example.com, name@example.com",
    });
    const saved = store.get("draft-1");
    expect(saved.subject).toBe("Re: Training enquiry (revised)");
    expect(saved.toText).toBe("clinic@example.com, name@example.com");
    expect(saved.status).toBe("ready");

    let delivered: string | undefined;
    await expect(
      store.send("draft-1", async () => {
        throw new Error("mailbox refused");
      }),
    ).rejects.toThrow(/mailbox refused/);
    expect(store.get("draft-1").status).toBe("ready");

    const sent = await store.send("draft-1", async (mail) => {
      delivered = mail.subject;
    });
    expect(delivered).toBe("Re: Training enquiry (revised)");
    expect(sent.subject).toBe("Re: Training enquiry (revised)");
    expect(sent.body).toBe("Hi,\n\nThe course is one day.\n");
    expect(sent.to).toEqual(["clinic@example.com", "name@example.com"]);
    expect(sent.subject).not.toBe(original.subject);
    expect(store.open("draft-1").statusLabel).toBe("Sent");
    expect(store.open("draft-1").editable).toBe(false);
    expect(() => store.edit("draft-1", { subject: "again" })).toThrow(EmailReplyDraftError);
  });

  it("leaves a discarded draft unsent", () => {
    const store = new EmailReplyDraftStore();
    store.save(createEmailReplyDraft(original));
    store.edit("draft-1", { subject: "Do not send" });
    const discarded = store.discard("draft-1");
    expect(discarded.status).toBe("discarded");
    expect(discarded.subject).toBe("Do not send");
    expect(() => emailReplyOutbound(discarded)).toThrow(/discarded/);
  });

  it("refuses to send a draft with no recipient", () => {
    const store = new EmailReplyDraftStore();
    store.save(createEmailReplyDraft(original));
    store.edit("draft-1", { to: "" });
    expect(() => emailReplyOutbound(store.get("draft-1"))).toThrow(/recipient/);
    expect(store.get("draft-1").status).toBe("ready");
  });

  it("reopens a stored block, including one whose address would not send", () => {
    const store = new EmailReplyDraftStore();
    store.save(createEmailReplyDraft(original));
    store.edit("draft-1", { cc: "matt@example.com" });
    const block = emailReplyBlock(store.get("draft-1"));
    const reopened = emailReplyDraftFromBlock(block);
    expect(reopened.ccText).toBe("matt@example.com");
    expect(emailReplyOutbound(reopened).cc).toEqual(["matt@example.com"]);

    const odd = emailReplyDraftFromBlock({
      ...block,
      from: "not an address",
      to: ["clinic@"],
    });
    expect(odd.from).toBe("not an address");
    expect(odd.toText).toBe("clinic@");
    expect(() => emailReplyOutbound(odd)).toThrow(EmailReplyDraftError);
  });
});
