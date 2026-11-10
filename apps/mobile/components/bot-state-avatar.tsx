import type { LogoAvatarActivity } from "@rakazo/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image } from "react-native";
import {
  expressionSlotForActivity,
  useExpressionFaces,
  useExpressionPack,
} from "../lib/expression-avatar";
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
  userId,
  size,
  status,
  activity,
  composing = false,
}: {
  botId: string | undefined;
  /** The account whose custom or subscribed faces render; built-in faces without one. */
  userId?: string;
  size: number;
  status: string | undefined;
  activity?: LogoAvatarActivity;
  composing?: boolean;
}) {
  const pack = useExpressionPack(botId);
  const faces = useExpressionFaces(userId, botId);
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
  // The gallery always carries all six slots, so the slot is always present.
  const face = faces.find((item) => item.id === expressionSlotForActivity(resolved, justFinished))!;
  return (
    <Image
      source={face.image}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      accessibilityLabel={resolved}
    />
  );
}
