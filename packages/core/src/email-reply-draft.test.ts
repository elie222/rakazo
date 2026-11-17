import { describe, expect, it } from "vitest";
import {
  EmailReplyDraftError,
  EmailReplyDraftStore,
  createEmailReplyDraft,
  emailReplyBlock,
  emailReplyDraftFromBlock,
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
  it("opens the saved draft", () => {
    const store = new EmailReplyDraftStore();
    const card = store.save(createEmailReplyDraft(original));
    expect(card.title).toBe("Reply");
    expect(card.statusLabel).toBe("Ready to send");
    expect(card.from).toBe(original.from);
    expect(card.inReplyTo).toBe(original.inReplyTo);
    expect(card.to).toBe("clinic@example.com");
    expect(card.cc).toBe("name@example.com");
    expect(card.subject).toBe(original.subject);
    expect(card.editable).toBe(true);
    expect(emailReplyPreview(store.get(card.draftId))).toBe("The reply draft is ready…");
  });

  it("writes edits back and sends the draft as it stands", () => {
    const store = new EmailReplyDraftStore();
    store.save(createEmailReplyDraft(original));
    store.edit("draft-1", { subject: "Re: Training enquiry (revised)" });
    store.edit("draft-1", {
      body: "Hi,\n\nThe course is one day.\n",
      to: "clinic@example.com, name@example.com",
    });
    const saved = store.get("draft-1");
    expect(saved.subject).toBe("Re: Training enquiry (revised)");
    expect(saved.body).toBe("Hi,\n\nThe course is one day.\n");
    expect(saved.to).toEqual(["clinic@example.com", "name@example.com"]);
    expect(saved.status).toBe("ready");

    const sent = store.send("draft-1");
    expect(sent.subject).toBe("Re: Training enquiry (revised)");
    expect(sent.body).toBe("Hi,\n\nThe course is one day.\n");
    expect(sent.to).toEqual(["clinic@example.com", "name@example.com"]);
    expect(sent.subject).not.toBe(original.subject);
    expect(store.open("draft-1").statusLabel).toBe("Sent");
    expect(store.open("draft-1").editable).toBe(false);
    expect(() => store.edit("draft-1", { subject: "again" })).toThrow(EmailReplyDraftError);
    expect(() => store.send("draft-1")).toThrow(/already sent/);
  });

  it("leaves a discarded draft unsent", () => {
    const store = new EmailReplyDraftStore();
    store.save(createEmailReplyDraft(original));
    store.edit("draft-1", { subject: "Do not send" });
    const discarded = store.discard("draft-1");
    expect(discarded.status).toBe("discarded");
    expect(discarded.subject).toBe("Do not send");
    expect(() => store.send("draft-1")).toThrow(/discarded/);
  });

  it("refuses to send a draft with no recipient", () => {
    const store = new EmailReplyDraftStore();
    store.save(createEmailReplyDraft(original));
    store.edit("draft-1", { to: "" });
    expect(() => store.send("draft-1")).toThrow(/recipient/);
    expect(store.get("draft-1").status).toBe("ready");
  });

  it("reopens the same draft from its saved block", () => {
    const store = new EmailReplyDraftStore();
    store.save(createEmailReplyDraft(original));
    store.edit("draft-1", { cc: "matt@example.com" });
    const block = emailReplyBlock(store.get("draft-1"));
    const reopened = new EmailReplyDraftStore();
    reopened.save(emailReplyDraftFromBlock(block));
    expect(reopened.get("draft-1").cc).toEqual(["matt@example.com"]);
    expect(reopened.send("draft-1").cc[0]).toBe("matt@example.com");
  });
});
