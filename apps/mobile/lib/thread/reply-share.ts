import { useLingui } from "@lingui/react/macro";
import { sharedReplyText } from "@rakazo/core";
import { redactSensitiveText } from "@rakazo/logging/redaction";
import * as Clipboard from "expo-clipboard";
import { useCallback } from "react";
import { Alert } from "react-native";
import { rpc } from "../api/api";
import type { MobileMessage } from "../api/mobile-types";
import { errorText } from "../api/user-error";
import type { MobileArtifactTarget } from "../artifacts/artifact-open";
import { accountRpcQuery, queryClient } from "../query/query";

/**
 * Shows what a bot reply's public link would show, in a native alert, and makes the link only
 * when Copy link is pressed.
 */
export function useReplyShare(target: MobileArtifactTarget | undefined) {
  const { t } = useLingui();
  return useCallback(
    (message: MobileMessage) => {
      if (!target) return;
      const copyLink = async () => {
        let shareUrl: string;
        try {
          ({ shareUrl } = await rpc("replyShares/create", { ...target, messageId: message.id }));
        } catch (cause) {
          Alert.alert(t`Could not continue`, errorText(cause, t`Try again.`));
          return;
        }
        void queryClient.invalidateQueries({
          queryKey: accountRpcQuery("replyShares/list").queryKey,
        });
        const copied = await Clipboard.setStringAsync(shareUrl).catch(() => false);
        // The link exists either way, so a failed copy still shows it to copy by hand.
        if (copied === false) Alert.alert(t`Could not copy the link.`, shareUrl);
        else Alert.alert(t`Link copied`);
      };
      Alert.alert(
        t`Anyone with the link can read this reply`,
        sharedReplyText(message, redactSensitiveText),
        [
          { text: t`Cancel`, style: "cancel" },
          { text: t`Copy link`, isPreferred: true, onPress: () => void copyLink() },
        ],
      );
    },
    [t, target],
  );
}
