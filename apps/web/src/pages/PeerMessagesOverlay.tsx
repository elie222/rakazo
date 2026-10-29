import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { BotAvatarSet } from "@rakazo/contracts";
import { loadPeerHistory, peerConversations } from "@rakazo/core";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef } from "react";
import { desktopBridge } from "../lib/desktop";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { transcriptIsNearEnd } from "../lib/transcript-scroll";
import { WindowChrome } from "./WindowChrome";

/**
 * Full-screen view-only transcript of a bot-to-bot exchange.
 * Opened from a Messaged / Message from chip in the human thread.
 */
export function PeerMessagesOverlay({
  botId,
  botName,
  botColor,
  botAvatarSet,
  peerBotId,
  peerBotName: initialPeerBotName,
  peerBotColor,
  peerBotAvatarSet,
  onClose,
}: {
  botId: string;
  botName: string;
  botColor: string;
  botAvatarSet?: BotAvatarSet;
  peerBotId: string;
  peerBotName: string;
  peerBotColor: string;
  peerBotAvatarSet?: BotAvatarSet;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const history = useQuery({
    queryKey: [
      ...queries.threads.messages.queryKey({
        input: { botId, includePeerRuns: true },
      }),
      "peer-history",
    ],
    queryFn: ({ signal }) =>
      loadPeerHistory({
        signal,
        loadPage: (before, pageSignal) =>
          rpc.threads.messages({ botId, before, includePeerRuns: true }, { signal: pageSignal }),
      }),
  });
  // A revisit shows the cached exchange while it refreshes; Retry shows its progress.
  const historyReady = history.data !== undefined || !history.isFetching;
  const historyFailed = history.data === undefined && history.isError;
  const conversation = useMemo(() => {
    if (!history.data) return null;
    return peerConversations(history.data).find((entry) => entry.peerBotId === peerBotId) ?? null;
  }, [history.data, peerBotId]);
  const peerBotName = conversation?.peerBotName ?? initialPeerBotName;
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followingEnd = useRef(true);
  // Opens at the latest message like the chat transcript, and follows a refresh while still there.
  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (element && conversation && followingEnd.current) element.scrollTop = element.scrollHeight;
  }, [conversation]);

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
        <div className="app-drag flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {desktopBridge() ? <WindowChrome /> : null}
            <div className="flex items-center -space-x-2">
              <BotAvatar avatarSet={botAvatarSet} color={botColor} identity={botId} size={28} />
              <BotAvatar
                avatarSet={peerBotAvatarSet}
                color={peerBotColor}
                identity={peerBotId}
                size={28}
              />
            </div>
            <DialogTitle className="flex min-w-0 gap-2 text-[15.5px] font-medium" dir="auto">
              <span className="truncate text-foreground">{botName}</span>
              <span className="truncate text-muted-foreground">{peerBotName}</span>
            </DialogTitle>
          </div>
          <DialogClose
            aria-label={t`Close`}
            render={<Button variant="ghost" size="sm" className="app-no-drag" />}
          >
            <Trans>Close</Trans>
          </DialogClose>
        </div>

        {history.data !== undefined && history.isError && !history.isFetching ? (
          <div
            role="alert"
            className="flex items-center justify-center gap-2 px-4 pt-3 text-[13px] text-destructive"
          >
            <Trans>Could not load this chat.</Trans>
            <Button variant="link" size="xs" onClick={() => void history.refetch()}>
              <Trans>Retry now</Trans>
            </Button>
          </div>
        ) : null}
        {!historyReady ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <Spinner aria-label={t`Loading…`} />
          </div>
        ) : historyFailed ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <div className="flex flex-col items-center gap-3">
              <Trans>Could not load this chat.</Trans>
              <Button variant="outline" size="sm" onClick={() => void history.refetch()}>
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
            ref={transcriptRef}
            data-testid="peer-conversation-transcript"
            onScroll={(event) => {
              followingEnd.current = transcriptIsNearEnd(event.currentTarget);
            }}
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

        <div className="flex items-center gap-4 border-t border-sidebar-border px-[18px] py-3.5">
          <p className="text-[13.5px] text-muted-foreground/80">
            <Trans>This chat is view-only</Trans>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
