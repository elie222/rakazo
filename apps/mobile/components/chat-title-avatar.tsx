import type { SpaceBot } from "@rakazo/contracts";
import type { LogoAvatarActivity } from "@rakazo/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useExpressionPack } from "../lib/expression-avatar";
import { mobileLogoAvatarActivity } from "../lib/logo-avatar-activity";
import type { MobileBot } from "../lib/mobile-types";
import { useThemedStyles } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { BotStateAvatar } from "./bot-state-avatar";
import { NativeSymbol } from "./native-symbol";

/**
 * The avatar in a one-to-one chat's title capsule. The mockup's header avatar is twice its
 * 17pt title, and the capsule is 44pt tall, so 34 leaves room for the done badge's overhang.
 */
export const CHAT_TITLE_AVATAR_SIZE = 34;

/**
 * The done badge, as in the mockup: a green disc overhanging the avatar. The mockup's
 * 88pt hero carries a 27pt badge with a 16pt check and a 5pt overhang; the 34pt capsule
 * keeps the smaller 15pt badge, 9pt check, 3pt overhang.
 */
const DONE_BADGE_MS = 2500;

const WORKING_ACTIVITIES: ReadonlySet<LogoAvatarActivity> = new Set([
  "reading",
  "writing",
  "thinking",
  "computer",
  "working",
]);

function createChatTitleAvatarStyles(size: number) {
  const tokens = mobileTokens();
  const doneBadgeSize = size >= 80 ? 27 : 15;
  const doneBadgeOverhang = size >= 80 ? 5 : 3;
  return StyleSheet.create({
    placeholder: {
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: tokens.secondary,
    },
    avatar: {
      width: size,
      height: size,
    },
    doneBadge: {
      position: "absolute",
      right: -doneBadgeOverhang,
      bottom: -doneBadgeOverhang,
      width: doneBadgeSize,
      height: doneBadgeSize,
      borderRadius: doneBadgeSize / 2,
      backgroundColor: tokens.success,
      borderWidth: 2,
      borderColor: "#fff",
      alignItems: "center",
      justifyContent: "center",
    },
  });
}

/**
 * The bot's avatar in a chat title. While the bot isn't known yet a plain circle holds the
 * avatar's place, so the capsule has its final width from the first frame of the push. A run
 * finishing shows the done face with its green check badge, as in the mockup; the other
 * states are already the face itself, so they get no badge. The size is fixed per mount: the
 * title capsule uses the default, the chat's big hero uses the large size.
 */
export function ChatTitleAvatar({
  bot,
  status,
  composing,
  size = CHAT_TITLE_AVATAR_SIZE,
}: {
  bot: MobileBot | SpaceBot | undefined;
  status: string | undefined;
  composing: boolean;
  /** The avatar's diameter; the capsule default is CHAT_TITLE_AVATAR_SIZE. */
  size?: number;
}) {
  const styles = useThemedStyles(() => createChatTitleAvatarStyles(size));
  const pack = useExpressionPack(bot?.id);
  // The same live activity BotStateAvatar resolves, so the badge tracks its done face.
  const liveActivity = useSyncExternalStore(
    mobileLogoAvatarActivity.subscribe,
    () => mobileLogoAvatarActivity.getActivity(bot?.id ?? "", status),
    (): LogoAvatarActivity => "idle",
  );
  const resolved =
    composing && (liveActivity === "working" || liveActivity === "idle") ? "writing" : liveActivity;
  const [justFinished, setJustFinished] = useState(false);
  const previous = useRef<LogoAvatarActivity>(resolved);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const was = previous.current;
    previous.current = resolved;
    if (WORKING_ACTIVITIES.has(was) && resolved === "idle") {
      setJustFinished(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setJustFinished(false), DONE_BADGE_MS);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [resolved]);
  if (!bot) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.placeholder}
      />
    );
  }
  const showDoneBadge = pack === "chief" && justFinished;
  return (
    <View style={styles.avatar}>
      {pack === "chief" ? (
        <BotStateAvatar botId={bot.id} size={size} status={status} composing={composing} />
      ) : (
        <BotAvatar
          color={bot.color}
          avatarSet={bot.avatarSet}
          identity={bot.id}
          size={size}
          status={status}
          composing={composing}
          muted={bot.notifyOnFinish === false}
        />
      )}
      {showDoneBadge ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.doneBadge}
        >
          <NativeSymbol
            ios="checkmark"
            android="checkmark"
            size={size >= 80 ? 16 : 9}
            color="#fff"
          />
        </View>
      ) : null}
    </View>
  );
}
