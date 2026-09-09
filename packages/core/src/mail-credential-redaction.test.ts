import { describe, expect, it } from "vitest";
import {
  isMailConnectorReadTool,
  MAIL_CREDENTIAL_REDACTION,
  redactMailConnectorReadPayload,
  redactMailCredentialText,
} from "./mail-credential-redaction.js";

describe("mail credential redaction", () => {
  it("detects Gmail, Outlook, and generic mail read tools", () => {
    expect(isMailConnectorReadTool("GMAIL_FETCH_EMAILS")).toBe(true);
    expect(isMailConnectorReadTool("OUTLOOK_GET_MESSAGE")).toBe(true);
    expect(isMailConnectorReadTool("list_inbox_messages", { connectorSlug: "imap" })).toBe(true);
    expect(isMailConnectorReadTool("gmail_send_email")).toBe(false);
    expect(isMailConnectorReadTool("CRM_LIST_RECORDS")).toBe(false);
    expect(isMailConnectorReadTool("fetch_messages", { connectorSlug: "microsoft_outlook" })).toBe(
      true,
    );
  });

  it("redacts labeled OTP-like codes", () => {
    const text = "Your verification code is 482917. Do not share it.";
    const redacted = redactMailCredentialText(text);
    expect(redacted).toContain(MAIL_CREDENTIAL_REDACTION);
    expect(redacted).not.toContain("482917");
  });

  it("redacts password-reset HTTPS URLs", () => {
    const text =
      "Reset here: https://accounts.example.test/reset-password?token=abc123&email=a@b.test";
    const redacted = redactMailCredentialText(text);
    expect(redacted).toContain(MAIL_CREDENTIAL_REDACTION);
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toMatch(/https:\/\/accounts\.example\.test\/reset-password/);
  });

  it("redacts magic-link query patterns", () => {
    const text = "Sign in: https://app.example.test/session/start?magic_link=ml_9f3a&next=/home";
    const redacted = redactMailCredentialText(text);
    expect(redacted).toContain(MAIL_CREDENTIAL_REDACTION);
    expect(redacted).not.toContain("ml_9f3a");
  });

  it("redacts nested mail read payloads and leaves non-mail tools alone", () => {
    const payload = {
      messages: [
        {
          subject: "Password reset",
          body: "Code: 991122. Link: https://id.example.test/reset?token=RESET-TOKEN-9f3a",
        },
      ],
    };

    expect(redactMailConnectorReadPayload("GMAIL_LIST_MESSAGES", payload)).toEqual({
      messages: [
        {
          subject: "Password reset",
          body: expect.stringContaining(MAIL_CREDENTIAL_REDACTION),
        },
      ],
    });
    const redacted = redactMailConnectorReadPayload("GMAIL_LIST_MESSAGES", payload) as {
      messages: Array<{ body: string }>;
    };
    expect(redacted.messages[0]!.body).not.toContain("991122");
    expect(redacted.messages[0]!.body).not.toContain("RESET-TOKEN-9f3a");

    expect(redactMailConnectorReadPayload("CRM_LIST_RECORDS", payload)).toEqual(payload);
    expect(redactMailConnectorReadPayload("GMAIL_SEND_EMAIL", payload)).toEqual(payload);
  });

  it("preserves ordinary mail content without credential material", () => {
    const body = "The launch is blocked by the unsigned contract. Review it by Friday.";
    expect(redactMailCredentialText(body)).toBe(body);
  });
});
