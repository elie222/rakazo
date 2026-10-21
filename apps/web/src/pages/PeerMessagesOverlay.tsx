import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import {
  formatTimeSeparator,
  loadPeerHistory,
  needsTimeSeparator,
  peerConversations,
} from "@rakazo/core";
import { BotAvatar, Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { ArrowRightLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ArtifactFileCard } from "../components/ArtifactFileCard";
import { rpc } from "../lib/rpc";
import { ArtifactImage } from "./shell/message-cards";

/**
 * Full-screen view-only transcript of a bot-to-bot exchange.
 * Opened from a centred exchange line in the human thread.
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
  const { t, i18n } = useLingui();
  const [messages, setMessages] = useState<readonly ThreadMessage[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const conversation = useMemo(() => {
    if (!historyReady) return null;
    return peerConversations(messages).find((entry) => entry.peerBotId === peerBotId) ?? null;
  }, [historyReady, messages, peerBotId]);
  const peerBotName = conversation?.peerBotName ?? initialPeerBotName;

  useEffect(() => {
    const abort = new AbortController();
    setHistoryReady(false);
    setHistoryFailed(false);
    setMessages([]);
    void loadPeerHistory({
      signal: abort.signal,
      loadPage: (before, signal) =>
        rpc.threads.messages({ botId, before, includePeerRuns: true }, { signal }),
    })
      .then((loaded) => {
        if (abort.signal.aborted) return;
        setMessages(loaded);
        setHistoryReady(true);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setHistoryFailed(true);
        setHistoryReady(true);
      });
    return () => {
      abort.abort();
    };
  }, [botId, reloadKey]);

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
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center bg-linear-to-b from-background via-background/90 to-transparent px-4 pt-4 pb-8">
          <DialogTitle className="flex max-w-full items-center gap-2 rounded-full bg-muted px-4 py-2 text-[13px] font-medium">
            <BotAvatar color={botColor} identity={botId} size={20} />
            <span className="truncate" dir="auto">
              {botName}
            </span>
            <ArrowRightLeft
              size={14}
              className="shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <BotAvatar color={peerBotColor} identity={peerBotId} size={20} />
            <span className="truncate" dir="auto">
              {peerBotName}
            </span>
          </DialogTitle>
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
                <Trans>Retry now</Trans>
              </Button>
            </div>
          </div>
        ) : !conversation || conversation.messages.length === 0 ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <Trans>No messages with {peerBotName} yet.</Trans>
          </div>
        ) : (
          <div
            data-testid="peer-conversation-transcript"
            className="rk-scroll min-h-0 flex-1 overflow-y-auto px-4 pt-20 pb-28 md:px-7"
          >
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
              {conversation.messages.map((peerMessage, index) => {
                const sent = peerMessage.direction === "sent";
                const speakerId = sent ? botId : peerBotId;
                const color = sent ? botColor : peerBotColor;
                return (
                  <div key={`${peerMessage.messageId}-${index}`}>
                    {needsTimeSeparator(
                      peerMessage.createdAt,
                      conversation.messages[index - 1]?.createdAt,
                    ) ? (
                      <div className="my-3 text-center text-xs text-muted-foreground">
                        {formatTimeSeparator(peerMessage.createdAt, i18n.locale, {
                          today: t`Today`,
                          yesterday: t`Yesterday`,
                        })}
                      </div>
                    ) : null}
                    <div className="flex items-end gap-2">
                      <BotAvatar color={color} identity={speakerId} size={20} />
                      <div className="min-w-0 max-w-[88%]">
                        <div
                          className="mb-1 px-[18px] text-[12px] font-medium"
                          style={{ color }}
                          dir="auto"
                        >
                          {sent ? botName : peerBotName}
                        </div>
                        <div
                          className="max-w-full space-y-2.5 rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90"
                          dir="auto"
                        >
                          <ChatMarkdown>{peerMessage.text}</ChatMarkdown>
                          {peerMessage.blocks?.map((block, i) =>
                            block.kind === "image" ? (
                              <ArtifactImage
                                key={`${block.artifactId}-${i}`}
                                target={{ botId }}
                                artifactId={block.artifactId}
                                name={block.name}
                              />
                            ) : block.kind === "file" ? (
                              <ArtifactFileCard
                                key={`${block.artifactId}-${i}`}
                                target={{ botId }}
                                artifactId={block.artifactId}
                                name={block.name}
                                mimeType={block.mimeType}
                                size={block.size}
                              />
                            ) : null,
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-linear-to-t from-background to-transparent px-4 pt-8 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <DialogClose
            render={
              <Button
                variant="secondary"
                className="pointer-events-auto h-11 rounded-full px-6 font-medium"
              />
            }
          >
            <Trans>Close Chat</Trans>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
