import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { ComputerReleaseReason, MessageBlock } from "@rakazo/contracts";
import {
  TAKEOVER_COMPUTER_DONE_STATE,
  TAKEOVER_COMPUTER_PENDING_STATE,
  TAKEOVER_COMPUTER_SKIPPED_STATE,
} from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useEffect, useState } from "react";
import type { ViewProps } from "react-native";
import {
  Alert,
  AppState,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { threadCardWidth } from "../lib/message-presentation";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useThreadReadOnly } from "../lib/thread-read-only";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { NativeSymbol } from "./native-symbol";

const styles = StyleSheet.create({
  card: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14 },
  header: { alignItems: "center", flexDirection: "row", gap: 8 },
  icon: { alignItems: "center", borderRadius: 7, height: 28, justifyContent: "center", width: 28 },
  title: { flexShrink: 0, ...typeScale.cardTitle },
  summary: { flex: 1, ...typeScale.caption },
  heading: { marginTop: 12, ...typeScale.cardTitle },
  body: { marginTop: 2 },
  preview: {
    aspectRatio: 16 / 10,
    borderRadius: 10,
    marginTop: 12,
    width: "100%",
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "flex-end",
    marginTop: 12,
  },
});

type ComputerBlock = Extract<MessageBlock, { kind: "computer" }>;

/**
 * A bot's request to use its computer. While it waits it shows the screen and the answers;
 * once settled it folds to one line that opens to show what was asked.
 */
export function ComputerCard({
  block,
  botId,
  runId,
  onOpen,
  accessibilityActions,
  onAccessibilityAction,
}: {
  block: ComputerBlock;
  botId?: string;
  runId?: string;
  onOpen?: () => void;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useLingui();
  const readOnly = useThreadReadOnly();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { width: windowWidth } = useWindowDimensions();
  const pending = block.state === TAKEOVER_COMPUTER_PENDING_STATE;
  const [expanded, setExpanded] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const image = useComputerPreview(pending && !readOnly ? botId : undefined, runId);
  const label =
    block.state === TAKEOVER_COMPUTER_PENDING_STATE
      ? t`Needs you`
      : block.state === TAKEOVER_COMPUTER_SKIPPED_STATE
        ? t`Skipped`
        : block.state === TAKEOVER_COMPUTER_DONE_STATE
          ? t`Done`
          : block.state;
  const open = pending || expanded;
  const canAct = Boolean(onOpen) && !readOnly;

  async function release(reason: ComputerReleaseReason) {
    if (!botId) return;
    setReleasing(true);
    // An answer that went through stays busy until the card settles, so it cannot be sent twice.
    try {
      await rpc("computer/release", { botId, runId, reason });
    } catch (error) {
      setReleasing(false);
      Alert.alert(t`Could not continue`, errorText(error));
    }
  }

  const header = (
    <View style={styles.header}>
      <View style={[styles.icon, { backgroundColor: native.fill }]}>
        <NativeSymbol
          ios="laptopcomputer"
          android="laptop-outline"
          size={16}
          color={tokens.mutedForeground}
        />
      </View>
      <Text
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        style={[styles.title, { color: tokens.foreground }]}
      >
        {t`Computer`}
      </Text>
      {open ? null : (
        <Text numberOfLines={1} style={[styles.summary, { color: tokens.mutedForeground }]}>
          {label} · {block.text}
        </Text>
      )}
    </View>
  );

  return (
    <View
      testID="computer-card"
      style={[styles.card, { width: threadCardWidth(windowWidth), backgroundColor: native.fill }]}
    >
      {pending ? (
        header
      ) : (
        <Pressable
          testID="computer-card-toggle"
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
        >
          {header}
        </Pressable>
      )}
      {open ? (
        <>
          <Text style={[styles.heading, { color: tokens.foreground }]}>{label}</Text>
          {block.text ? (
            <View style={styles.body}>
              <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
                {block.text}
              </ChatMarkdown>
            </View>
          ) : null}
          {pending && image ? (
            <Pressable accessible={false} disabled={!canAct} onPress={onOpen}>
              <Image
                testID="computer-card-preview"
                source={{ uri: image }}
                resizeMode="contain"
                style={[
                  styles.preview,
                  {
                    backgroundColor: tokens.background,
                    borderColor: tokens.border,
                    borderWidth: StyleSheet.hairlineWidth,
                  },
                ]}
              />
            </Pressable>
          ) : null}
          {canAct && onOpen ? (
            <View style={styles.actions}>
              {pending && botId ? (
                <>
                  <NativeActionButton
                    label={t`Skip`}
                    prominence="secondary"
                    size="compact"
                    busy={releasing}
                    onPress={() => void release("skipped")}
                  />
                  <NativeActionButton
                    label={t`I’m done`}
                    prominence="secondary"
                    size="compact"
                    busy={releasing}
                    onPress={() => void release("done")}
                  />
                </>
              ) : null}
              <View testID="computer-card-open">
                <NativeActionButton
                  label={t`Open computer`}
                  prominence={pending ? "primary" : "secondary"}
                  fill={false}
                  size="compact"
                  disabled={releasing}
                  onPress={onOpen}
                />
              </View>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/** A still of the bot's screen while the card waits, read again when the app returns. */
function useComputerPreview(botId: string | undefined, runId: string | undefined) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    // A card that turns read-only or moves to another run never keeps the earlier screen.
    setImage(null);
    if (!botId) return;
    let live = true;
    // Only the latest read may draw, so a slow earlier capture never covers a newer one.
    let latest = 0;
    const load = () => {
      const request = ++latest;
      return rpc("computer/preview", { botId, runId })
        .then((result) => {
          if (live && request === latest) setImage(result.image);
        })
        .catch(() => undefined);
    };
    void load();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, [botId, runId]);
  return image;
}
