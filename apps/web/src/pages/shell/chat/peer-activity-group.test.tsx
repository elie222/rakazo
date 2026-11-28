// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { foldPeerReplies, peerExchangeLines } from "@rakazo/core";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupTranscriptItems, HandoffGroupRow, PeerReceiptGroupRow } from "./peer-activity-group";

vi.mock("@lingui/core/macro", () => ({
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, str, idx) => acc + str + (values[idx] ?? ""), ""),
  }),
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: ({ identity }: { identity?: string }) => (
    <span data-testid="bot-avatar" data-bot={identity} />
  ),
  GroupAvatar: () => <span data-testid="group-avatar" />,
}));

function makeMessage(id: string, blocks: ThreadMessage["blocks"], botId = "bot-1"): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    botId,
    blocks,
    createdAt: "2026-11-26T23:05:00.000Z",
  };
}

const bots: Record<string, { name: string; color: string }> = {
  chief: { name: "Chief", color: "#3b82f6" },
  linkedin: { name: "LinkedIn Manager", color: "#a855f7" },
  reddit: { name: "Reddit Manager", color: "#f97316" },
  x: { name: "X Manager", color: "#ef4444" },
};
const peerBot = (botId: string) => bots[botId];
const memberName = (botId: string | undefined) => (botId ? bots[botId]?.name : undefined);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("groupTranscriptItems & HandoffGroupRow", () => {
  it("collapses consecutive multi-bot handoffs into one 'Messaged 3 Bots' line and expands on click", () => {
    const messages = [
      makeMessage(
        "m1",
        [
          {
            kind: "handoff",
            fromBotId: "linkedin",
            toBotId: "chief",
            text: "LinkedIn report body",
          },
        ],
        "linkedin",
      ),
      makeMessage(
        "m2",
        [{ kind: "handoff", fromBotId: "reddit", toBotId: "chief", text: "Reddit report body" }],
        "reddit",
      ),
      makeMessage(
        "m3",
        [{ kind: "handoff", fromBotId: "x", toBotId: "chief", text: "X report body" }],
        "x",
      ),
    ];
    const items = messages.map((message) => ({ kind: "message" as const, message }));
    const exchanges = peerExchangeLines(foldPeerReplies(messages, { includePeerReceipts: true }));
    const grouped = groupTranscriptItems(items, exchanges, false);
    expect(grouped.items).toHaveLength(1);
    expect(grouped.items[0]?.kind).toBe("handoffGroup");
    expect(grouped.anchorOf.get("m2")).toBe("m1");
    expect(grouped.anchorOf.get("m3")).toBe("m1");

    act(() =>
      root.render(
        <HandoffGroupRow messages={messages} memberName={memberName} peerBot={peerBot} />,
      ),
    );
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="handoff-group-chip"]')!;
    expect(chip.getAttribute("aria-label")).toBe("Messaged 3 Bots");
    expect(chip.querySelectorAll('[data-testid="bot-avatar"]')).toHaveLength(3);
    expect(host.querySelector('[data-testid="handoff-group-details"]')).toBeNull();

    act(() => chip.click());
    const details = host.querySelector('[data-testid="handoff-group-details"]');
    expect(details?.textContent).toContain("LinkedIn report body");
    expect(details?.textContent).toContain("Reddit report body");
    expect(details?.textContent).toContain("X report body");
  });

  it("collapses consecutive multi-bot peer receipts into one 'Messaged 2 Bots' line", () => {
    const messages = [
      makeMessage("p1", [
        {
          kind: "bot_message_sent",
          toBotId: "linkedin",
          toBotName: "LinkedIn Manager",
          text: "Go",
        },
      ]),
      makeMessage("p2", [
        { kind: "bot_message_sent", toBotId: "reddit", toBotName: "Reddit Manager", text: "Go" },
      ]),
    ];
    const items = messages.map((message) => ({ kind: "message" as const, message }));
    const exchanges = peerExchangeLines(foldPeerReplies(messages, { includePeerReceipts: true }));
    const grouped = groupTranscriptItems(items, exchanges, false);
    expect(grouped.items).toHaveLength(1);
    const group = grouped.items[0];
    expect(group?.kind).toBe("peerReceiptGroup");
    if (group?.kind !== "peerReceiptGroup") throw new Error("expected peerReceiptGroup");

    const onOpenPeerMessages = vi.fn();
    act(() =>
      root.render(
        <PeerReceiptGroupRow
          entries={group.entries}
          groupContext={false}
          peerBot={peerBot}
          onOpenPeerMessages={onOpenPeerMessages}
        />,
      ),
    );
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="peer-group-chip"]')!;
    expect(chip.getAttribute("aria-label")).toBe("Messaged 2 Bots");
    act(() => chip.click());
    const buttons = [...host.querySelectorAll('[data-testid="peer-group-links"] button')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      "LinkedIn Manager",
      "Reddit Manager",
    ]);
    act(() => (buttons[1] as HTMLButtonElement).click());
    expect(onOpenPeerMessages).toHaveBeenCalledWith({
      peerBotId: "reddit",
      peerBotName: "Reddit Manager",
    });
  });

  it("keeps mixed attachment receipts ungrouped, respects boundaries, and labels incoming receipts truthfully", () => {
    const messages = [
      makeMessage("r1", [
        {
          kind: "bot_message_received",
          fromBotId: "linkedin",
          fromBotName: "LinkedIn Manager",
          text: "Hi",
        },
      ]),
      makeMessage("r2", [
        {
          kind: "bot_message_received",
          fromBotId: "reddit",
          fromBotName: "Reddit Manager",
          text: "Hi",
        },
      ]),
      makeMessage("r3", [
        { kind: "bot_message_received", fromBotId: "x", fromBotName: "X Manager", text: "File" },
        {
          kind: "file",
          artifactId: "a1",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 10,
        },
      ]),
    ];
    const items = messages.map((message) => ({ kind: "message" as const, message }));
    const exchanges = peerExchangeLines(foldPeerReplies(messages, { includePeerReceipts: true }));
    const grouped = groupTranscriptItems(items, exchanges, false);
    expect(grouped.items.map((entry) => entry.kind)).toEqual(["peerReceiptGroup", "message"]);

    const splitByUnread = groupTranscriptItems(items, exchanges, false, { unreadDividerId: "r2" });
    expect(splitByUnread.items.map((entry) => entry.kind)).toEqual([
      "message",
      "message",
      "message",
    ]);

    const group = grouped.items[0];
    if (group?.kind !== "peerReceiptGroup") throw new Error("expected peerReceiptGroup");
    act(() =>
      root.render(
        <PeerReceiptGroupRow
          entries={group.entries}
          groupContext={false}
          peerBot={peerBot}
          onOpenPeerMessages={vi.fn()}
        />,
      ),
    );
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="peer-group-chip"]')!;
    expect(chip.getAttribute("aria-label")).toBe("Messages from 2 Bots");
  });
});
