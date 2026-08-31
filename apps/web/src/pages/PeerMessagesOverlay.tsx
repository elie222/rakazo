import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { BotAvatar } from "@rakazo/ui-web";
import { useEffect, useMemo, useRef, useState } from "react";
import { peerConversations } from "../lib/peer-messages";
import { rpc } from "../lib/rpc";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Full-screen view-only transcript of a bot-to-bot exchange.
 * Opened from a Messaged / Message from chip in the human thread.
 */
export function PeerMessagesOverlay({
  botId,
  botName,
  botColor,
  peerBotId,
  peerBotName: initialPeerBotName,
  peerBotColor,
  onClose,
}: {
  botId: string;
  botName: string;
  botColor: string;
  peerBotId: string;
  peerBotName: string;
  peerBotColor: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [messages, setMessages] = useState<readonly ThreadMessage[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const conversation = useMemo(() => {
    if (!historyReady) return null;
    return peerConversations(messages).find((entry) => entry.peerBotId === peerBotId) ?? null;
  }, [historyReady, messages, peerBotId]);
  const peerBotName = conversation?.peerBotName ?? initialPeerBotName;
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const loadRef = useRef({ botId });

  useEffect(() => {
    let cancelled = false;
    const { botId: id } = loadRef.current;
    setHistoryReady(false);
    setHistoryFailed(false);
    void (async () => {
      let before: number | undefined;
      let collected: ThreadMessage[] = [];
      do {
        const page = await rpc.threads.messages({ botId: id, before, includePeerRuns: true });
        if (cancelled) return;
        collected = [...page.messages, ...collected];
        before = page.olderCursor ?? undefined;
      } while (before !== undefined);
      if (cancelled) return;
      setMessages(collected);
      setHistoryReady(true);
    })().catch(() => {
      if (cancelled) return;
      setHistoryFailed(true);
      setHistoryReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>('[data-testid="shell-root"]');
    const inerted: HTMLElement[] = [];
    if (shell) {
      for (const child of Array.from(shell.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (!panelRef.current || child.contains(panelRef.current)) continue;
        if (child.inert) continue;
        child.inert = true;
        inerted.push(child);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    panelRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      for (const element of inerted) element.inert = false;
      previousFocus?.focus();
    };
  }, []);

  const title = `${botName} · ${peerBotName}`;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="peer-conversation-title"
      data-testid="peer-conversation-view"
      tabIndex={-1}
      className="absolute inset-0 z-50 flex flex-col bg-[#050506] outline-none"
    >
      <div className="flex items-center justify-between gap-4 border-b border-[#171719] px-[18px] py-3.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex items-center -space-x-2">
            <BotAvatar color={botColor} identity={botId} size={28} />
            <BotAvatar color={peerBotColor} identity={peerBotId} size={28} />
          </div>
          <h1
            id="peer-conversation-title"
            className="truncate text-[15.5px] font-medium text-[#ECECEE]"
            dir="auto"
          >
            {title}
          </h1>
        </div>
        <button
          type="button"
          aria-label={t`Close`}
          onClick={onClose}
          className="rounded-[9px] px-3 py-1.5 text-[13.5px] text-[#A8A8AD] hover:bg-[#1B1B1E] hover:text-[#ECECEE]"
        >
          <Trans>Close</Trans>
        </button>
      </div>

      {!historyReady ? (
        <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-[#6C6C70]">
          <Trans>Loading…</Trans>
        </div>
      ) : historyFailed ? (
        <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-[#6C6C70]">
          <Trans>Could not load this chat.</Trans>
        </div>
      ) : !conversation || conversation.messages.length === 0 ? (
        <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-[#6C6C70]">
          <Trans>No messages with {peerBotName} yet.</Trans>
        </div>
      ) : (
        <div
          data-testid="peer-conversation-transcript"
          className="rk-scroll flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-5 md:px-7 md:py-6"
        >
          {conversation.messages.map((peerMessage, index) => {
            const sent = peerMessage.direction === "sent";
            return (
              <div
                key={`${peerMessage.messageId}-${index}`}
                className={`flex ${sent ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-[16px] px-4 py-2.5 ${
                    sent ? "bg-[#1F1F23]" : "bg-[#17171A]"
                  }`}
                >
                  <div className="mb-1 text-[12px] text-[#7A7A80]" dir="auto">
                    {sent ? botName : peerBotName}
                  </div>
                  <div className="text-[14.5px] leading-[1.5] text-[#DFDFE2]" dir="auto">
                    <ChatMarkdown>{peerMessage.text}</ChatMarkdown>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-4 border-t border-[#171719] px-[18px] py-3.5">
        <p className="text-[13.5px] text-[#6C6C70]">
          <Trans>This chat is view-only</Trans>
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-[9px] border border-[#2A2A2F] bg-[#141416] px-3.5 py-1.5 text-[13.5px] text-[#ECECEE] hover:bg-[#1B1B1E]"
        >
          <Trans>Close</Trans>
        </button>
      </div>
    </div>
  );
}
