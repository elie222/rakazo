import { useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import { formatTimeSeparator, isPeerReceiptBlocks, replyLineText } from "@rakazo/core";
import { X } from "lucide-react";
import { useEffect } from "react";

export function TimeSeparator({ createdAt, locale }: { createdAt: string; locale: string }) {
  const { t } = useLingui();
  return (
    <h3
      data-testid="time-separator"
      className="my-3 select-none text-center text-xs font-normal text-muted-foreground"
    >
      {formatTimeSeparator(createdAt, locale, { today: t`Today`, yesterday: t`Yesterday` })}
    </h3>
  );
}

export function ComposerReplyPreview({
  author,
  text,
  onDismiss,
}: {
  author: string;
  text: string;
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);
  return (
    <div
      data-testid="reply-chip"
      className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-muted px-3 py-1.5 text-[13px]"
    >
      <span className="min-w-0 flex-1 truncate text-muted-foreground" dir="auto">
        <span className="font-medium">{author}</span>: {text.split(/\r?\n/u)[0]}
      </span>
      <button
        type="button"
        aria-label={t`Cancel reply`}
        onClick={onDismiss}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

export function ReplyLine({
  message,
  fallbackText,
  author,
  onJump,
}: {
  message: ThreadMessage;
  fallbackText?: string;
  author: string;
  onJump?: (id: string) => void;
}) {
  const { t } = useLingui();
  // Peer receipts use internal reply links for routing; their bodies belong in the peer view.
  if (isPeerReceiptBlocks(message.blocks)) return null;
  if (!message.replyToMessageId && message.replyQuote == null) return null;
  const unavailable = message.replyPreview === null || !message.replyToMessageId;
  if (unavailable)
    return (
      <div
        data-testid="reply-parent-preview"
        className="mb-1 truncate text-xs text-muted-foreground"
      >{t`Original message unavailable`}</div>
    );
  const text = replyLineText(message.replyQuote, message.replyPreview?.text, fallbackText);
  const excerpt = text.replace(/\s+/gu, " ").slice(0, 120);
  return (
    <button
      type="button"
      data-testid="reply-parent-preview"
      aria-label={t`Jump to replied message: ${excerpt}`}
      onClick={() => {
        if (message.replyToMessageId) onJump?.(message.replyToMessageId);
      }}
      className="mb-1 block max-w-full truncate text-start text-xs text-muted-foreground hover:text-foreground"
      dir="auto"
    >
      ↩ {author}: {text}
    </button>
  );
}
