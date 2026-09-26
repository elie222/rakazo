import { useLingui } from "@lingui/react/macro";
import { BotAvatar, Button, cn } from "@rakazo/ui-web";
import { Captions, Mic, MicOff, PhoneOff, Settings, User } from "lucide-react";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { endCall, toggleMute, toggleTranscript, useCallSession } from "../../lib/call-session";

const BARS = [9, 15, 21, 15, 9];
const TRANSCRIPT_LINES = 4;
const EDITABLE = /^(?:input|textarea|select)$/i;

export function CallCard({ onSettings }: { onSettings: () => void }) {
  const { t } = useLingui();
  const call = useCallSession();
  const navigate = useNavigate();
  const { botId } = useParams();
  const onCall = Boolean(call);
  useEffect(() => {
    if (!onCall) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || EDITABLE.test(target?.tagName ?? "")) return;
      endCall();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCall]);
  if (!call) return null;
  const onBotScreen = botId === call.botId;
  return (
    <div
      data-testid="call-view"
      className="fixed end-4 top-4 z-50 w-[360px] rounded-2xl border border-border bg-card p-3 shadow-lg"
    >
      <div className="flex items-center gap-2.5">
        <BotAvatar color={call.botColor} identity={call.botId} size={28} />
        <button
          type="button"
          aria-label={t`On a call with ${call.botName}`}
          onClick={() => {
            if (!onBotScreen) navigate(`/app/${call.botId}`);
          }}
          className="min-w-0 truncate text-[14.5px] font-medium text-foreground hover:text-foreground/70"
          dir="auto"
        >
          {call.botName}
        </button>
        <div className="flex flex-1 items-center justify-center gap-[3px]" aria-hidden="true">
          {BARS.map((height, index) => (
            <span
              key={`bar-${index + 1}`}
              className={cn(
                "w-[3px] rounded-full",
                call.phase === "thinking"
                  ? "bg-muted-foreground/40"
                  : "animate-pulse bg-foreground",
              )}
              style={{
                height,
                animationDelay: `${index * 90}ms`,
                animationDuration: call.phase === "speaking" ? "600ms" : "1200ms",
              }}
            />
          ))}
        </div>
        <span
          className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
          aria-hidden="true"
        >
          <User className="size-3.5" />
        </span>
      </div>
      <div className="mt-3 flex items-center justify-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={t`Settings`}
          onClick={onSettings}
        >
          <Settings />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={t`Transcript`}
          aria-pressed={call.transcriptOpen}
          onClick={toggleTranscript}
        >
          <Captions />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={call.muted ? t`Unmute` : t`Mute`}
          aria-pressed={call.muted}
          onClick={toggleMute}
        >
          {call.muted ? <MicOff className="text-muted-foreground" /> : <Mic />}
        </Button>
        <Button
          variant="destructive"
          size="icon"
          className="rounded-full"
          aria-label={t`Hang up`}
          onClick={endCall}
        >
          <PhoneOff />
        </Button>
      </div>
      {call.transcriptOpen ? (
        <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-2.5 text-[13px] leading-[1.45]">
          {call.exchanges.slice(-TRANSCRIPT_LINES).map((exchange, index) => (
            <p
              key={`${exchange.role}-${index + 1}-${exchange.text.slice(0, 24)}`}
              className={cn(
                "truncate",
                exchange.role === "bot" ? "text-foreground" : "text-muted-foreground",
              )}
              dir="auto"
            >
              {exchange.text}
            </p>
          ))}
          {call.caption || call.heard ? (
            <p className="truncate text-muted-foreground/70" dir="auto">
              {call.caption || call.heard}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
