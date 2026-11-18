import type { OutgoingDraft } from "@rakazo/contracts";
import { CATALOG_APPROVAL_TOOL, outgoingDraftAnswer } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { editOutgoingDraft } from "./outgoing-draft.js";

const draft: OutgoingDraft = {
  source: "Mail",
  keys: { to: "recipient", subject: "subject", body: "body" },
  values: { kind: "email", to: "first@example.test", subject: "Review", body: "First draft" },
};
const args = { recipient: "first@example.test", subject: "Review", body: "First draft" };
const values = {
  kind: "email",
  to: "second@example.test",
  subject: "Revised",
  body: "Edited text",
} as const;
const edited = { recipient: values.to, subject: values.subject, body: values.body };
const route = { connectionId: "original-account", toolName: "send_email" };

describe("editOutgoingDraft", () => {
  it.each([
    { request: args, expected: edited },
    {
      request: [CATALOG_APPROVAL_TOOL, "direct", { route, args }],
      expected: [CATALOG_APPROVAL_TOOL, "direct", { route, args: edited }],
    },
    {
      request: [
        CATALOG_APPROVAL_TOOL,
        "app_execute_tool",
        { id: "original", arguments: args },
        route,
      ],
      expected: [
        CATALOG_APPROVAL_TOOL,
        "app_execute_tool",
        { id: "original", arguments: edited },
        route,
      ],
    },
  ])("changes the editable arguments and preserves the approved route", ({ request, expected }) => {
    expect(
      editOutgoingDraft({ id: "effect", request }, draft, outgoingDraftAnswer(values)),
    ).toEqual({
      values,
      request: expected,
    });
  });

  it("edits a single action and refuses a batch with a different operation or more actions", () => {
    const batch = { items: "tools", action: "action", arguments: "arguments", operation: "send" };
    const item = { action: "send", arguments: args };
    const answer = outgoingDraftAnswer(values);
    const batchDraft = { ...draft, batch };
    expect(
      editOutgoingDraft({ id: "effect", request: { tools: [item] } }, batchDraft, answer),
    ).toEqual({
      values,
      request: { tools: [{ ...item, arguments: edited }] },
    });
    expect(
      editOutgoingDraft({ id: "effect", request: { tools: [item, item] } }, batchDraft, answer),
    ).toBeUndefined();
    expect(
      editOutgoingDraft(
        { id: "effect", request: { tools: [{ ...item, action: "another" }] } },
        batchDraft,
        answer,
      ),
    ).toBeUndefined();
  });

  it("keeps an omitted email body absent unless the owner writes one", () => {
    const original = { to: draft.values.to, subject: "Review" };
    const subjectOnly = {
      ...draft,
      keys: { ...draft.keys, to: "to" },
      values: { ...values, to: original.to, body: "" },
    };
    const effect = { id: "effect", request: { ...original, subject: values.subject } };
    expect(
      editOutgoingDraft(effect, subjectOnly, outgoingDraftAnswer(subjectOnly.values))?.request,
    ).toEqual(effect.request);
    expect(editOutgoingDraft(effect, subjectOnly, outgoingDraftAnswer(values))?.request).toEqual({
      to: values.to,
      subject: values.subject,
      body: values.body,
    });
  });

  it("can edit a conversation from a channel ID to a named channel", () => {
    const message = { kind: "message", to: "C12345", body: "Note" } as const;
    const update = { ...message, to: "#general" };
    const card = { source: "Team chat", keys: { to: "channel", body: "text" }, values: message };
    const effect = { id: "effect", request: { channel: message.to, text: message.body } };
    expect(editOutgoingDraft(effect, card, outgoingDraftAnswer(update))?.request).toEqual({
      channel: "#general",
      text: message.body,
    });
  });

  it("rejects an unreviewed request, invalid destination or extra arguments", () => {
    const effect = { id: "effect", request: args };
    expect(editOutgoingDraft(effect, draft, "allow")).toBeUndefined();
    expect(
      editOutgoingDraft(effect, draft, outgoingDraftAnswer({ ...values, subject: "", body: "" })),
    ).toBeUndefined();
    expect(
      editOutgoingDraft(effect, draft, outgoingDraftAnswer({ ...values, to: "invalid" })),
    ).toBeUndefined();
    expect(
      editOutgoingDraft(
        effect,
        draft,
        JSON.stringify({ outgoingDraft: { ...values, bcc: ["hidden@example.test"] } }),
      ),
    ).toBeUndefined();
    expect(
      editOutgoingDraft({ ...effect, request: edited }, draft, outgoingDraftAnswer(values)),
    ).toBeUndefined();
  });
});
