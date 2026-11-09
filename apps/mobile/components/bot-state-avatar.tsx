import type { LogoAvatarActivity } from "@rakazo/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image } from "react-native";
import { expressionImageFor, useExpressionPack } from "../lib/expression-avatar";
import { mobileLogoAvatarActivity } from "../lib/logo-avatar-activity";

/** How long the done face shows after a run finishes, before resting again. */
const DONE_FACE_MS = 2500;

const WORKING_ACTIVITIES: ReadonlySet<LogoAvatarActivity> = new Set([
  "reading",
  "writing",
  "thinking",
  "computer",
  "working",
]);

/**
 * A bot's avatar as a state expression: one chief face per activity state. A run finishing
 * shows the done face briefly, then the avatar rests on the thinking face. When the pack is
 * off, it renders nothing, and the caller falls back to the regular avatar.
 */
export function BotStateAvatar({
  botId,
  size,
  status,
  activity,
  composing = false,
}: {
  botId: string | undefined;
  size: number;
  status: string | undefined;
  activity?: LogoAvatarActivity;
  composing?: boolean;
}) {
  const pack = useExpressionPack(botId);
  const liveActivity = useSyncExternalStore(
    mobileLogoAvatarActivity.subscribe,
    () => mobileLogoAvatarActivity.getActivity(botId ?? "", status),
    (): LogoAvatarActivity => "idle",
  );
  const resolved =
    activity ??
    (composing && (liveActivity === "working" || liveActivity === "idle")
      ? "writing"
      : liveActivity);
  const [justFinished, setJustFinished] = useState(false);
  const previous = useRef<LogoAvatarActivity>(resolved);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const was = previous.current;
    previous.current = resolved;
    if (WORKING_ACTIVITIES.has(was) && resolved === "idle") {
      setJustFinished(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setJustFinished(false), DONE_FACE_MS);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [resolved]);
  if (pack !== "chief") return null;
  return (
    <Image
      source={expressionImageFor(resolved, justFinished)}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      accessibilityLabel={resolved}
    />
  );
}
