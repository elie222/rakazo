import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentHttpsUrl, displayName as safeDisplayName } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { MobileBot, MobileSnapshot } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { useResolvedAppearance } from "../../lib/native";
import type { UserBubble } from "../../lib/user-bubble";
import { withUserBubble } from "../../lib/user-bubble";
import { BotMention } from "../bot-mention";
import { NativeSymbol } from "../native-symbol";
import type { MessageActionProps } from "./message-bubble";
import type { MessageRowActions } from "./message-row";

// A running helper's live card and the saved message that replaces it have different ids, so
// its row mounts again when the helper finishes. Remember open cards by agent id across that.
const openHelpers = new Set<string>();

export type SpecialMessageBlock = Extract<
  MessageBlock,
  { kind: "subagent" | "child_bot" | "cloud_agent" }
>;

export function isSpecialMessageBlock(block: MessageBlock): block is SpecialMessageBlock {
  return block.kind === "subagent" || block.kind === "child_bot" || block.kind === "cloud_agent";
}

type SpecialMessageCardProps = {
  special: SpecialMessageBlock;
  actionProps: MessageActionProps;
  bots: MobileBot[];
  members?: MobileSnapshot["members"];
  onOpenBot: (botId: string, name: string) => void;
  onHelperToggle?: MessageRowActions["helperToggle"];
  userBubble?: UserBubble;
};

function HelperMessageCard({
  special,
  actionProps,
  onHelperToggle,
  userBubble,
}: Pick<SpecialMessageCardProps, "actionProps" | "onHelperToggle" | "userBubble"> & {
  special: Extract<MessageBlock, { kind: "subagent" }>;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = withUserBubble(mobileTokens(), userBubble);
  const { t } = useI18n();
  const helperHeader = useRef<View>(null);
  const helperCard = useRef<View>(null);
  const helperReducedMotion = useReducedMotion();
  const [subagentOpen, setSubagentOpen] = useState(() => openHelpers.has(special.agentId));
  const helperRotation = useSharedValue(subagentOpen ? 180 : 0);
  useEffect(() => {
    helperRotation.value = helperReducedMotion
      ? subagentOpen
        ? 180
        : 0
      : withTiming(subagentOpen ? 180 : 0, { duration: 150 });
  }, [subagentOpen, helperReducedMotion, helperRotation]);
  const helperChevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${helperRotation.value}deg` }],
  }));
  const running = special.status === "running";
  const failed = special.status === "failed";
  return (
    <Pressable
      {...actionProps}
      ref={helperCard}
      collapsable={false}
      style={{
        width: "90%",
        borderRadius: 18,
        backgroundColor: tokens.card,
      }}
    >
      <Pressable
        {...actionProps}
        onPress={() => {
          const toggle = () => {
            if (subagentOpen) openHelpers.delete(special.agentId);
            else openHelpers.add(special.agentId);
            setSubagentOpen(!subagentOpen);
          };
          if (onHelperToggle) {
            onHelperToggle(
              (done) =>
                helperHeader.current?.measureInWindow((_x, y) => {
                  helperCard.current?.measureInWindow((_cardX, cardY, _width, height) =>
                    done(y, cardY + height),
                  );
                }),
              toggle,
              !subagentOpen,
            );
          } else toggle();
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: subagentOpen }}
        style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 14, minHeight: 44 }}
      >
        <View ref={helperHeader} collapsable={false}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Text
              style={{
                flexShrink: 1,
                flexGrow: 1,
                color: tokens.foreground,
                ...typeScale.cardTitle,
              }}
            >
              {safeDisplayName(special.name, t("subagent"))}
            </Text>
            <Text
              style={{
                color: failed ? tokens.destructive : running ? tokens.warning : tokens.success,
                ...typeScale.caption,
              }}
            >
              {running
                ? t("Running")
                : special.status === "failed"
                  ? t("Failed")
                  : special.status === "completed"
                    ? t("Completed")
                    : special.status}
            </Text>
            <Animated.View style={helperChevronStyle}>
              <NativeSymbol
                ios="chevron.down"
                android="chevron-down"
                size={12}
                color={tokens.mutedForeground}
              />
            </Animated.View>
          </View>
          {special.task ? (
            <Text
              numberOfLines={subagentOpen ? undefined : 1}
              style={{ color: tokens.mutedForeground, marginTop: 8, ...typeScale.secondary }}
            >
              {special.task}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {subagentOpen && (special.result || special.progress) ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 14, marginTop: -6 }}>
          <ChatMarkdown palette={tokens} colorScheme={colorScheme} streaming={running}>
            {special.result || special.progress || ""}
          </ChatMarkdown>
        </View>
      ) : null}
    </Pressable>
  );
}

export function SpecialMessageCard(props: SpecialMessageCardProps) {
  const { special, actionProps, bots, members, onOpenBot, userBubble } = props;
  const tokens = withUserBubble(mobileTokens(), userBubble);
  const { t } = useI18n();
  if (special.kind === "subagent") return <HelperMessageCard {...props} special={special} />;
  if (special.kind === "cloud_agent") {
    const title = special.title || t("Cloud agent");
    const statusLabel =
      special.status === "running"
        ? t("running")
        : special.status === "finished"
          ? t("finished")
          : special.status === "cancelled"
            ? t("cancelled")
            : special.status === "expired"
              ? t("expired")
              : t("failed");
    const running = special.status === "running";
    const failed = special.status !== "running" && special.status !== "finished";
    const prHref = cloudAgentHttpsUrl(special.prUrl);
    const href = prHref ?? cloudAgentHttpsUrl(special.url);
    return (
      <Pressable
        {...actionProps}
        onPress={() => {
          if (href) Linking.openURL(href).catch(() => undefined);
        }}
        testID="cloud-agent-card"
        accessibilityRole={href ? "link" : "text"}
        accessibilityLabel={`${title}: ${statusLabel}`}
        disabled={!href}
        style={{
          width: "90%",
          borderRadius: 18,
          backgroundColor: tokens.card,
          paddingHorizontal: 16,
          paddingVertical: 14,
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ flexShrink: 1, color: tokens.cardForeground, ...typeScale.cardTitle }}>
            {title}
          </Text>
          <Text
            style={{
              color: failed ? tokens.destructive : running ? tokens.warning : tokens.success,
              ...typeScale.caption,
            }}
          >
            {statusLabel}
          </Text>
        </View>
        {prHref ? (
          <Text style={{ color: tokens.mutedForeground, marginTop: 8, ...typeScale.secondary }}>
            {t("Pull request")}
          </Text>
        ) : special.branch ? (
          <Text style={{ color: tokens.mutedForeground, marginTop: 8, ...typeScale.secondary }}>
            {special.branch}
          </Text>
        ) : null}
      </Pressable>
    );
  }
  if (special.kind === "child_bot") {
    return (
      <Text
        {...actionProps}
        style={{
          alignSelf: "flex-start",
          paddingHorizontal: 4,
          color: tokens.mutedForeground,
          ...typeScale.body,
        }}
      >
        <BotMention
          block={special}
          color={
            bots.find((bot) => bot.id === special.botId)?.color ??
            members?.find((member) => member.botId === special.botId)?.color
          }
          tokens={tokens}
          onOpenBot={onOpenBot}
        />
        {special.status === "archived"
          ? ` ${t("archived")}`
          : special.status === "deleted"
            ? ` ${t("deleted")}`
            : null}
      </Text>
    );
  }
  return null;
}
