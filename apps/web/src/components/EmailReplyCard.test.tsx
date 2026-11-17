// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const emailReply = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../lib/rpc", () => {
  const rpc = { threads: { emailReply } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + (index ? values[index - 1] : "") + part, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { EmailReplyCard } from "./EmailReplyCard";

const block: Extract<MessageBlock, { kind: "email_reply" }> = {
  kind: "email_reply",
  draftId: "draft-1",
  from: "ops@mail.example.com",
  inReplyTo: "<clinic@example.com>",
  to: ["clinic@example.com"],
  cc: [],
  subject: "Re: Training enquiry",
  body: "Hello",
  status: "ready",
  approval: "needs_approval",
};

function open(reply: typeof block) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <EmailReplyCard block={reply} messageId="message-1" target={{ botId: "bot-1" }} />
      </QueryClientProvider>,
    );
  });
  return {
    host,
    text: () => host.textContent ?? "",
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("EmailReplyCard", () => {
  const opened: Array<{ unmount: () => void }> = [];
  afterEach(() => {
    for (const card of opened.splice(0)) card.unmount();
    emailReply.mockClear();
  });

  it("opens a reply as Mail, with the message it answers", () => {
    const card = open(block);
    opened.push(card);
    expect(card.host.querySelector('[data-testid="email-reply-card"]')).not.toBeNull();
    expect(card.text()).toContain("Mail");
    expect(card.text()).toContain("ops@mail.example.com");
    expect(card.text()).toContain("In reply to");
    expect(card.text()).toContain("Re: Training enquiry");
    expect(card.text()).toContain("Send");
    expect(card.text()).toContain("Discard");
  });

  it("opens a new message without an in-reply row", () => {
    const card = open({ ...block, inReplyTo: undefined });
    opened.push(card);
    expect(card.text()).toContain("Mail");
    expect(card.text()).not.toContain("In reply to");
  });
});
