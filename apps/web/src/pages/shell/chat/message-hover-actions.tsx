import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageReaction, ThreadMessage } from "@rakazo/contracts";
import { canReactToThreadMessage, MESSAGE_REACTIONS } from "@rakazo/contracts";
import { canMarkMessageUnread, copyableMessageText, formatTimeSeparator } from "@rakazo/core";
import {
  CopyTextFallback,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useCopyText,
} from "@rakazo/ui-web";
import { Check, Copy, MessageSquareDot, MoreHorizontal, Reply, Smile } from "lucide-react";
import { useState } from "react";
import { MessageHoverMetadata } from "../../../components/messages/MessageHoverMetadata";
import { isPendingSendMessage } from "../../../lib/composer/pending-send";

export function MessageHoverActions({
  message,
  side,
  speakerName,
  onReply,
  onMarkUnread,
  markedUnread = false,
  onReact,
}: {
  message: ThreadMessage;
  side: "start" | "end";
  /** Names whose message this is, when the chat names speakers. */
  speakerName?: string;
  onReply: (message: ThreadMessage) => void;
  onMarkUnread: (message: ThreadMessage) => void;
  markedUnread?: boolean;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
}) {
  const { t } = useLingui();
  const [copiedNow, copy, copyFailed, resetCopy, copyFailedText] = useCopyText();
  // The text the last successful copy put on the clipboard: a message that changes during the
  // confirmation no longer shows as copied.
  const [copiedText, setCopiedText] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);

  // Streaming progress bubbles keep hover free for selection / stop clicks.
  if (message.id.startsWith("progress:")) return null;
  // A send the server has not confirmed has no stored message to act on yet.
  if (isPendingSendMessage(message)) return null;

  const when = formatTimeSeparator(message.createdAt, i18n.locale || "en", {
    today: t`Today`,
    yesterday: t`Yesterday`,
  });
  let groupLabel = t`Message actions`;
  if (speakerName && when) groupLabel = t`Message actions, ${speakerName}, ${when}`;
  else if (speakerName) groupLabel = t`Message actions, ${speakerName}`;
  else if (when) groupLabel = t`Message actions, ${when}`;
  const copied = copiedNow && copiedText === copyableMessageText(message);

  function copyMessage() {
    const text = copyableMessageText(message);
    if (!text) return;
    void copy(text).then((ok) => {
      if (ok) setCopiedText(text);
    });
  }

  const iconButtonClass =
    "grid h-11 w-11 place-items-center text-muted-foreground transition-colors hover:text-foreground [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7";

  return (
    <MessageHoverMetadata pinned={moreOpen || reactionsOpen || copied} side={side}>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset brings form styling the rail does not want */}
      <div
        data-testid="message-hover-actions"
        role="group"
        aria-label={groupLabel}
        className="flex items-center gap-0.5"
      >
        {canReactToThreadMessage(message) ? (
          <Popover open={reactionsOpen} onOpenChange={setReactionsOpen}>
            <PopoverTrigger aria-label={t`React`} className={iconButtonClass}>
              <Smile size={15} strokeWidth={1.7} />
            </PopoverTrigger>
            <PopoverContent
              align={side === "end" ? "start" : "end"}
              className="w-auto flex-row gap-0 rounded-2xl p-1.5"
              aria-label={t`Reactions`}
            >
              {MESSAGE_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  className="grid h-11 w-11 place-items-center rounded-xl text-heading1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    setReactionsOpen(false);
                    void onReact(message, emoji);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
        <button
          type="button"
          aria-label={t`Reply`}
          onClick={() => onReply(message)}
          className={iconButtonClass}
        >
          <Reply size={15} strokeWidth={1.7} />
        </button>
        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
          <DropdownMenuTrigger aria-label={t`More`} className={iconButtonClass}>
            {copied ? (
              <Check size={15} strokeWidth={1.7} />
            ) : (
              <MoreHorizontal size={15} strokeWidth={1.7} />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align={side === "end" ? "start" : "end"} className="w-auto">
            <DropdownMenuItem
              onClick={() => {
                setMoreOpen(false);
                onReply(message);
              }}
            >
              <Reply size={14} strokeWidth={1.7} />
              <Trans>Reply</Trans>
            </DropdownMenuItem>
            {canMarkMessageUnread(message) && !markedUnread ? (
              <DropdownMenuItem
                onClick={() => {
                  setMoreOpen(false);
                  onMarkUnread(message);
                }}
              >
                <MessageSquareDot size={14} strokeWidth={1.7} />
                <Trans>Mark as unread</Trans>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={copyMessage}>
              <Copy size={14} strokeWidth={1.7} />
              <Trans>Copy</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span role="status" className="sr-only">
          {copied ? t`Copied` : null}
        </span>
      </div>
      <CopyTextFallback
        open={copyFailed}
        onOpenChange={resetCopy}
        text={copyFailedText}
        label={t`Copy`}
      />
    </MessageHoverMetadata>
  );
}
