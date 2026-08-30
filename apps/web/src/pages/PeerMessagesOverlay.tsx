import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { peerConversations } from "../lib/peer-messages";
import { rpc } from "../lib/rpc";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Bot-to-bot traffic lives here rather than in the thread: it is the bots
 * working, not the conversation the user is having.
 */
export function PeerMessagesOverlay({
  botId,
  botName,
  initialPeerBotId,
  onClose,
}: {
  botId: string;
  botName: string;
  initialPeerBotId?: string | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [messages, setMessages] = useState<readonly ThreadMessage[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialPeerBotId ?? null);
  const conversations = useMemo(
    () => (historyReady ? peerConversations(messages) : []),
    [historyReady, messages],
  );
  const selected =
    conversations.find((conversation) => conversation.peerBotId === selectedId) ?? conversations[0];
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Overlay remounts each time it opens; load the dedicated raw peer history once.
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
      // Leave the empty state visible rather than showing a partial transcript-derived history.
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
        // Skip our host (and do nothing if the panel ref is not ready yet).
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

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#040405] p-4 sm:p-10">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="peer-messages-title"
        tabIndex={-1}
        className="flex h-[min(680px,100%)] w-[880px] max-w-full flex-col overflow-hidden rounded-[26px] border border-[#232326] bg-[#141416] shadow-[0_40px_90px_rgba(0,0,0,.55)] outline-none"
      >
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <div id="peer-messages-title" className="text-2xl font-medium text-[#F1F1F2]">
              <Trans>Bot messages</Trans>
            </div>
            <p className="mt-1 text-[13.5px] text-[#7A7A80]">
              {!historyReady ? (
                <Trans>Loading peer messages…</Trans>
              ) : historyFailed ? (
                <Trans>Could not load bot messages.</Trans>
              ) : conversations.length === 0 ? (
                t`${botName} has not messaged another bot yet.`
              ) : (
                t`${botName} · ${plural(conversations.length, { one: "# peer", other: "# peers" })}`
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label={t`Close bot messages`}
            onClick={onClose}
            className="text-[#85858A]"
          >
            ✕
          </button>
        </div>

        {!historyReady ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-[#6C6C70]">
            <Trans>Loading peer messages…</Trans>
          </div>
        ) : conversations.length === 0 ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-[#6C6C70]">
            <Trans>
              When {botName} messages another bot, the exchange shows up here instead of in the
              chat.
            </Trans>
          </div>
        ) : (
          <div className="mt-5 flex min-h-0 flex-1 flex-col gap-4 px-6 pb-6 sm:flex-row sm:px-8 sm:pb-7">
            <div className="max-h-40 w-full shrink-0 overflow-y-auto sm:max-h-none sm:w-[240px]">
              {conversations.map((conversation) => {
                const active = conversation.peerBotId === selected?.peerBotId;
                return (
                  <button
                    key={conversation.peerBotId}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => setSelectedId(conversation.peerBotId)}
                    className={`mb-1.5 block w-full rounded-[13px] border px-3.5 py-2.5 text-start ${
                      active
                        ? "border-[#2F2F34] bg-[#1B1B1E]"
                        : "border-transparent hover:bg-[#161618]"
                    }`}
                  >
                    <div className="truncate text-[14px] text-[#ECECEE]">
                      {conversation.peerBotName}
                    </div>
                    <div className="mt-0.5 truncate text-[12.5px] text-[#6C6C70]">
                      {conversation.lastText}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto rounded-[16px] border border-[#26262A] bg-[#101012] p-4">
              {selected?.messages.map((peerMessage, index) => {
                const sent = peerMessage.direction === "sent";
                return (
                  <div
                    key={`${peerMessage.messageId}-${index}`}
                    className={`mb-2.5 flex ${sent ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-[16px] px-4 py-2.5 ${
                        sent ? "bg-[#1F1F23]" : "bg-[#17171A]"
                      }`}
                    >
                      <div className="mb-1 text-[12px] text-[#7A7A80]">
                        {sent ? `${botName} → ${peerMessage.peerBotName}` : peerMessage.peerBotName}
                      </div>
                      <div className="text-[14.5px] leading-[1.5] text-[#DFDFE2]" dir="auto">
                        <ChatMarkdown>{peerMessage.text}</ChatMarkdown>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
