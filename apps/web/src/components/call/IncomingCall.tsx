import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { CALL_REQUEST_RING_MS } from "@rakazo/core";
import { BotAvatar, Button, defaultBotAvatarValue } from "@rakazo/ui-web";
import { BellRing, Phone, PhoneOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { startCall, useCallSession } from "../../lib/call-session";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { callClock } from "./CallCard";

/** Two short rising tones every two seconds: an incoming ring, unlike the outgoing ringback. */
function startRingtone(): () => void {
  const Context =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return () => undefined;
  let context: AudioContext;
  try {
    context = new Context();
  } catch {
    return () => undefined;
  }
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0;
  oscillator.connect(gain);
  gain.connect(context.destination);
  const start = context.currentTime + 0.05;
  for (let ring = 0; ring < 30; ring += 1) {
    const at = start + ring * 2;
    for (const offset of [0, 0.5]) {
      oscillator.frequency.setValueAtTime(659, at + offset);
      gain.gain.setValueAtTime(0.08, at + offset);
      oscillator.frequency.setValueAtTime(784, at + offset + 0.18);
      gain.gain.setValueAtTime(0, at + offset + 0.36);
    }
  }
  oscillator.start();
  return () => {
    try {
      oscillator.stop();
    } catch {
      // Already stopped.
    }
    void context.close().catch(() => undefined);
  };
}

type Ringing = { bot: Bot; call: NonNullable<Bot["incomingCall"]> };

/**
 * The bot is calling: rings until the user answers, declines, or
 * the call rings out. Answering hands over to the regular call window.
 */
export function IncomingCall({
  bots,
  transcribe,
  onAnswered,
}: {
  bots: Bot[];
  transcribe?: boolean;
  onAnswered: (botId: string) => void;
}) {
  const { t } = useLingui();
  const onCall = useCallSession() !== null;
  /** Calls this tab already acted on, so a stale roster poll cannot ring them again. */
  const [handled, setHandled] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notified = useRef(new Set<string>());

  const currentNow = Math.max(now, Date.now());
  const ringing: Ringing | null = onCall
    ? null
    : (bots
        .filter((bot) => bot.incomingCall && !handled.has(bot.incomingCall.callId))
        .map((bot) => ({ bot, call: bot.incomingCall as Ringing["call"] }))
        .find(({ call }) => Date.parse(call.expiresAt) > currentNow) ?? null);
  const callId = ringing?.call.callId;

  useEffect(() => {
    if (!callId) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [callId]);

  useEffect(() => {
    if (!callId) return;
    setError(null);
    return startRingtone();
  }, [callId]);

  const notification = useRef<Notification | null>(null);
  useEffect(() => {
    return () => {
      notification.current?.close();
      notification.current = null;
    };
  }, [callId]);

  useEffect(() => {
    if (!ringing || notified.current.has(ringing.call.callId)) return;
    if (document.visibilityState === "visible" || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const notice = new Notification(t`${ringing.bot.name} is calling you`, {
      tag: `call:${ringing.call.callId}`,
      requireInteraction: true,
    });
    notification.current = notice;
    notified.current.add(ringing.call.callId);
    notice.onclick = () => {
      window.focus();
      notice.close();
    };
  }, [ringing, t]);

  if (!ringing) return null;
  const { bot, call } = ringing;
  const startedAt = Date.parse(call.expiresAt) - CALL_REQUEST_RING_MS;
  const elapsed = Math.max(0, Math.floor((currentNow - startedAt) / 1000));

  const settle = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc.threads.declineCall({ botId: bot.id, callId: call.callId, outcome: "declined" });
      setHandled((current) => new Set(current).add(call.callId));
    } catch (cause) {
      setError(errorText(cause, t`Could not send that`));
    } finally {
      setBusy(false);
    }
  };

  const answer = async () => {
    setBusy(true);
    setError(null);
    try {
      const answered = await rpc.threads.answerCall({ botId: bot.id, callId: call.callId });
      setHandled((current) => new Set(current).add(call.callId));
      startCall({
        botId: bot.id,
        botName: bot.name,
        botColor: bot.color,
        transcribe,
        answered: { callId: call.callId, opening: answered.opening },
      });
      onAnswered(bot.id);
    } catch (cause) {
      if ((cause as { code?: string } | null)?.code === "CONFLICT") {
        setHandled((current) => new Set(current).add(call.callId));
      }
      setError(errorText(cause, t`This call is no longer ringing.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="incoming-call"
      role="alertdialog"
      aria-label={t`${bot.name} is calling you`}
      className="fixed inset-0 z-50 flex flex-col items-center bg-background px-7 pt-[max(env(safe-area-inset-top),56px)] pb-[max(env(safe-area-inset-bottom),40px)] md:inset-auto md:end-4 md:top-16 md:w-[360px] md:items-stretch md:gap-4 md:rounded-[22px] md:border md:border-border md:bg-card md:p-[18px] md:shadow-lg"
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-5 md:flex-none md:flex-row md:justify-start md:gap-3.5">
        <span className="relative grid size-32 shrink-0 place-items-center md:size-14">
          <span
            aria-hidden="true"
            className="absolute inset-0 animate-ping rounded-full border-2"
            style={{ borderColor: defaultBotAvatarValue(bot.color) }}
          />
          <span className="md:hidden">
            <BotAvatar color={bot.color} identity={bot.id} size={120} />
          </span>
          <span className="hidden md:block">
            <BotAvatar color={bot.color} identity={bot.id} size={52} />
          </span>
        </span>
        <span className="flex flex-col items-center gap-1 md:items-start">
          <span className="text-[28px] font-semibold text-foreground md:text-[17px]" dir="auto">
            {bot.name}
          </span>
          <span className="text-[15px] tabular-nums text-muted-foreground md:text-[13px]">
            {t`Calling you`} · {callClock(elapsed)}
          </span>
        </span>
        <p className="flex max-w-80 items-start gap-2 rounded-xl bg-muted px-3.5 py-2.5 text-[14px] leading-snug text-foreground md:hidden">
          <BellRing className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span dir="auto">{call.reason}</span>
        </p>
      </div>
      <p className="hidden items-start gap-2 rounded-xl bg-muted px-3 py-2 text-[13px] leading-snug text-foreground md:flex">
        <BellRing className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <span dir="auto">{call.reason}</span>
      </p>
      {error ? (
        <p role="alert" className="mb-4 text-center text-[13px] text-destructive md:mb-0">
          {error}
        </p>
      ) : null}
      <div className="grid w-full max-w-80 grid-cols-2 gap-3 md:max-w-none">
        <Button
          variant="destructive"
          className="h-14 rounded-full text-[15px] md:h-11 md:text-[14px]"
          disabled={busy}
          onClick={() => void settle()}
        >
          <PhoneOff className="size-5" aria-hidden="true" />
          {t`Decline`}
        </Button>
        <Button
          disabled={busy}
          className="h-14 rounded-full bg-success text-[15px] text-background hover:bg-success/90 md:h-11 md:text-[14px]"
          onClick={() => void answer()}
        >
          <Phone className="size-5" aria-hidden="true" />
          {t({ message: "Answer", context: "incoming call" })}
        </Button>
      </div>
    </div>
  );
}
