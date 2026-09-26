import { useLingui } from "@lingui/react/macro";
import {
  speechFromBlocks,
  type VoiceChatGroup,
  voiceChatDuration,
  voiceChatSummary,
} from "@rakazo/core";
import { buttonVariants, cn } from "@rakazo/ui-web";
import { AudioLines, ChevronDown } from "lucide-react";
import { useState } from "react";

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceChatCard({ group }: { group: VoiceChatGroup }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const summary = voiceChatSummary(group);
  return (
    <div
      data-testid="voice-chat-card"
      className="w-full max-w-[min(74%,calc(100%_-_6rem))] self-start rounded-[20px] border border-border bg-card"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="flex w-full items-center gap-2 px-3 py-2 text-start"
      >
        <AudioLines className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium text-foreground">{t`Voice chat`}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {clock(voiceChatDuration(group))}
        </span>
        <span
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-sm" }),
            "ms-auto pointer-events-none text-muted-foreground",
          )}
        >
          <span className="sr-only">{open ? t`Hide transcript` : t`Show transcript`}</span>
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </span>
      </button>
      {!open && summary ? (
        <p className="truncate px-3 pb-2 text-sm text-muted-foreground" dir="auto">
          {summary}
        </p>
      ) : null}
      {open ? (
        <div className="space-y-1.5 px-3 pb-3 text-sm">
          {group.messages.map((message) => {
            // The marker is the card's summary line, never a transcript turn.
            if (message === group.marker) return null;
            const text = speechFromBlocks(message.blocks).trim();
            if (!text) return null;
            return (
              <p
                key={message.id}
                dir="auto"
                className={cn(
                  message.role === "user"
                    ? "text-end text-muted-foreground"
                    : "rounded-md bg-muted/60 px-3 py-2 text-foreground",
                )}
              >
                {text}
              </p>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
