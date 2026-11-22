import { useLingui } from "@lingui/react/macro";
import { botInboundPath, isIdentityConfirmationRequired } from "@rakazo/contracts";
import { errorCode } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import * as Clipboard from "expo-clipboard";
import { Alert, Pressable, Text, View } from "react-native";
import { currentApiBase } from "../../lib/api/api";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import type { RoutineEventBlock } from "../../lib/messages/routine-event-label";
import { routineEventLabel } from "../../lib/messages/routine-event-label";
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
  const tokens = mobileTokens();
  return (
    <Pressable {...actionProps} style={{ width: "100%", paddingVertical: 4, alignItems: "center" }}>
      {blocks.map((block, index) => (
        <View
          key={`${block.change}-${index}`}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <Text
            style={{
              color: tokens.mutedForeground,
              fontSize: 13.5,
              textAlign: "center",
              flexShrink: 1,
            }}
          >
            {routineEventLabel(block)}
          </Text>
          {block.webhook && botId ? (
            <WebhookKeyButton botId={botId} title={block.name} color={tokens.mutedForeground} />
          ) : null}
        </View>
      ))}
    </Pressable>
  );
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
  const reveal = useSave({
    save: (_input, send) =>
      withIdentityConfirmation(() => send("bots/revealWebhookSecret", { botId })),
    onSaved: ({ secret }) => {
      const url = `${currentApiBase()}${botInboundPath(botId, "webhook")}`;
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
      if (isIdentityConfirmationRequired(error)) return;
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
