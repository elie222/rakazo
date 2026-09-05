import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { BotAvatar, Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { linkAbortSignal } from "../lib/link-abort-signal";
import { hasPeerConversation, peerConversations } from "../lib/peer-messages";
import { rpc } from "../lib/rpc";

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
  anchorMessageId,
  onClose,
}: {
  botId: string;
  botName: string;
  botColor: string;
  peerBotId: string;
  peerBotName: string;
  peerBotColor: string;
  anchorMessageId: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [messages, setMessages] = useState<readonly ThreadMessage[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const conversation = useMemo(() => {
    if (!historyReady) return null;
    return peerConversations(messages).find((entry) => entry.peerBotId === peerBotId) ?? null;
  }, [historyReady, messages, peerBotId]);
  const peerBotName = conversation?.peerBotName ?? initialPeerBotName;
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let historyDeadlineReached = false;
    let collected: ThreadMessage[] = [];
    const lifecycleAbort = new AbortController();
    const historyTimeout = window.setTimeout(() => {
      historyDeadlineReached = true;
      lifecycleAbort.abort();
    }, 60_000);
    setHistoryReady(false);
    setHistoryFailed(false);
    setMessages([]);
    void (async () => {
      const loadPage = async (target: { before?: number; around?: { messageId: string } }) => {
        const pageAbort = new AbortController();
        const abortPage = () => pageAbort.abort();
        // If the cumulative deadline already fired between pages, abort now —
        // a late addEventListener would miss the abort and wait on the page timer.
        const unlink = linkAbortSignal(lifecycleAbort.signal, abortPage);
        const timeout = window.setTimeout(abortPage, 15_000);
        return rpc.threads
          .messages({ botId, ...target, includePeerRuns: true }, { signal: pageAbort.signal })
          .finally(() => {
            window.clearTimeout(timeout);
            unlink();
          });
      };

      // Seed the transcript around the receipt the user clicked. Even when a
      // very large history hits the total deadline, the selected exchange is
      // therefore present in the partial transcript we render.
      const anchorPage = await loadPage({ around: { messageId: anchorMessageId } });
      collected = [...anchorPage.messages];

      let before: number | undefined;
      do {
        if (cancelled) return;
        if (historyDeadlineReached || lifecycleAbort.signal.aborted) {
          throw new DOMException("Peer history deadline reached", "AbortError");
        }
        const page = await loadPage(before === undefined ? {} : { before });
        if (cancelled) return;
        const merged = new Map(collected.map((message) => [message.id, message]));
        for (const message of page.messages) merged.set(message.id, message);
        collected = [...merged.values()].sort((a, b) => a.seq - b.seq);
        before = page.olderCursor ?? undefined;
      } while (before !== undefined);
      if (cancelled) return;
      setMessages(collected);
      setHistoryReady(true);
    })()
      .catch(() => {
        if (cancelled) return;
        // Deadline with pages: show only if the selected peer is present; else Retry.
        if (
          historyDeadlineReached &&
          collected.length > 0 &&
          hasPeerConversation(collected, peerBotId)
        ) {
          setMessages(collected);
        } else {
          setHistoryFailed(true);
        }
        setHistoryReady(true);
      })
      .finally(() => window.clearTimeout(historyTimeout));
    return () => {
      cancelled = true;
      window.clearTimeout(historyTimeout);
      lifecycleAbort.abort();
    };
  }, [anchorMessageId, botId, peerBotId, reloadKey]);

  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (!conversation || !element) return;
    element.scrollTop = element.scrollHeight;
  }, [conversation]);

  const title = `${botName} · ${peerBotName}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="peer-conversation-view"
        showCloseButton={false}
        className="inset-0 top-0 left-0 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 text-foreground ring-0 sm:max-w-none"
      >
        <div className="flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex items-center -space-x-2">
              <BotAvatar color={botColor} identity={botId} size={28} />
              <BotAvatar color={peerBotColor} identity={peerBotId} size={28} />
            </div>
            <DialogTitle className="truncate text-[15.5px] font-medium text-foreground" dir="auto">
              {title}
            </DialogTitle>
          </div>
          <DialogClose aria-label={t`Close`} render={<Button variant="ghost" size="sm" />}>
            <Trans>Close</Trans>
          </DialogClose>
        </div>

        {!historyReady ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <Trans>Loading…</Trans>
          </div>
        ) : historyFailed ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <div className="flex flex-col items-center gap-3">
              <Trans>Could not load this chat.</Trans>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReloadKey((value) => value + 1)}
              >
                <Trans>Retry</Trans>
              </Button>
            </div>
          </div>
        ) : !conversation || conversation.messages.length === 0 ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <Trans>No messages with {peerBotName} yet.</Trans>
          </div>
        ) : (
          <div
            ref={transcriptRef}
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
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                      sent ? "bg-accent" : "bg-muted"
                    }`}
                  >
                    <div className="mb-1 text-[12px] text-muted-foreground/70" dir="auto">
                      {sent ? botName : peerBotName}
                    </div>
                    <div className="text-[14.5px] leading-[1.5] text-foreground/90" dir="auto">
                      <ChatMarkdown>{peerMessage.text}</ChatMarkdown>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between gap-4 border-t border-sidebar-border px-[18px] py-3.5">
          <p className="text-[13.5px] text-muted-foreground/80">
            <Trans>This chat is view-only</Trans>
          </p>
          <DialogClose render={<Button variant="outline" size="sm" />}>
            <Trans>Close</Trans>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
