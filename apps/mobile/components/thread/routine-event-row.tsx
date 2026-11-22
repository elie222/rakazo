import { useLingui } from "@lingui/react/macro";
import { botInboundUrl, isIdentityConfirmationRequired } from "@rakazo/contracts";
import { errorCode } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import * as Clipboard from "expo-clipboard";
import { useIsFocused } from "expo-router";
import { useRef } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { currentApiBase } from "../../lib/api/api";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import type { RoutineEventBlock } from "../../lib/messages/routine-event-label";
import { routineEventLabel } from "../../lib/messages/routine-event-label";
import { useThemedStyles } from "../../lib/native/native";
import { useSave } from "../../lib/query/query";
import { NativeSymbol } from "../native/native-symbol";
import { useIdentityConfirmation } from "../vault/confirm-identity";
import type { MessageActionProps } from "./message-bubble";

/** The one-line chat rows for routines that were created, changed, switched on or off, or deleted. */
export function RoutineEventRows({
  blocks,
  botId,
  actionProps,
}: {
  blocks: RoutineEventBlock[];
  botId: string | undefined;
  actionProps: MessageActionProps;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable {...actionProps} style={styles.rows}>
      {blocks.map((block, index) => (
        <View key={`${block.change}-${index}`} style={styles.row}>
          <Text style={styles.label}>{routineEventLabel(block)}</Text>
          {block.webhook && botId ? (
            <WebhookKeyButton botId={botId} title={block.name} color={styles.label.color} />
          ) : null}
        </View>
      ))}
    </Pressable>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    rows: { width: "100%", paddingVertical: 4, alignItems: "center" },
    row: { flexDirection: "row", alignItems: "center", gap: 6 },
    label: {
      color: tokens.mutedForeground,
      fontSize: 13.5,
      textAlign: "center",
      flexShrink: 1,
    },
  });
}

/**
 * The key on a webhook routine's row: after the person confirms it's them, it shows the bot's
 * webhook URL and key, as the web routine editor does, with each one ready to copy.
 */
export function WebhookKeyButton({
  botId,
  title,
  color,
}: {
  botId: string;
  title: string;
  color: string;
}) {
  const { t } = useLingui();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  // A key or failure that arrives after the person left this chat is never shown over another one.
  const focused = useRef(false);
  focused.current = useIsFocused();
  const reveal = useSave({
    save: (_input, send) =>
      withIdentityConfirmation(() => send("bots/revealWebhookSecret", { botId })),
    onSaved: ({ secret, url: publishedUrl }) => {
      if (!focused.current) return;
      const url = publishedUrl ?? botInboundUrl(currentApiBase(), botId, "webhook");
      const copy = (text: string) =>
        void bestEffort("copy webhook", Clipboard.setStringAsync(text));
      Alert.alert(title, `${url}\n\nAuthorization: Bearer ${secret}`, [
        { text: t`Copy URL`, onPress: () => copy(url) },
        { text: t`Copy key`, onPress: () => copy(secret) },
        { text: t`Done`, style: "cancel" },
      ]);
    },
    onFailed: (error) => {
      // Dismissing the confirmation prompt is the person's choice, not a failure.
      if (!focused.current || isIdentityConfirmationRequired(error)) return;
      Alert.alert(
        errorCode(error) === "FORBIDDEN"
          ? t`Only the bot's creator can see its webhook key.`
          : errorText(error, t`Could not show the webhook key`),
      );
    },
  });
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t`Show webhook key`}
        accessibilityState={{ busy: reveal.pending }}
        hitSlop={10}
        onPress={() => reveal.run()}
      >
        <NativeSymbol ios="key" android="key-outline" size={13} color={color} />
      </Pressable>
      {identityDialog}
    </>
  );
}
