import { useLingui } from "@lingui/react/macro";
import { sharedReplyText } from "@rakazo/core";
import { redactSensitiveText } from "@rakazo/logging/redaction";
import * as Clipboard from "expo-clipboard";
import { useCallback } from "react";
import { Alert } from "react-native";
import type { MobileMessage } from "../api/mobile-types";
import { errorText } from "../api/user-error";
import type { MobileArtifactTarget } from "../artifacts/artifact-open";
import { accountRpcQuery, useSave } from "../query/query";

/**
 * Shows what a bot reply's public link would show, in a native alert, and makes the link only
 * when Copy link is pressed.
 */
export function useReplyShare(target: MobileArtifactTarget | undefined) {
  const { t } = useLingui();
  const save = useSave<{ message: MobileMessage }, { shareUrl: string }>({
    save: (input, send) => send("replyShares/create", { ...target!, messageId: input.message.id }),
    stale: [accountRpcQuery("replyShares/list").queryKey],
    onFailed: (cause) => Alert.alert(t`Could not continue`, errorText(cause, t`Try again.`)),
    onSaved: async (saved) => {
      const shareUrl = saved.shareUrl;
      const copied = await Clipboard.setStringAsync(shareUrl).catch(() => false);
      // The link exists either way, so a failed copy still shows it to copy by hand.
      if (copied === false) Alert.alert(t`Could not copy the link.`, shareUrl);
      else Alert.alert(t`Link copied`);
    },
  });
  return useCallback(
    (message: MobileMessage) => {
      if (!target) return;
      Alert.alert(
        t`Anyone with the link can read this reply`,
        sharedReplyText(message, redactSensitiveText),
        [
          { text: t`Cancel`, style: "cancel" },
          {
            text: t`Copy link`,
            isPreferred: true,
            onPress: () => save.run({ message }),
          },
        ],
      );
    },
    [t, target, save],
  );
}
