import type { AiRecipient } from "@rakazo/contracts";
import { AI_DATA_DISCLOSURES, AI_PRIVACY_URL } from "@rakazo/contracts";
import { Alert, Linking } from "react-native";

export function promptAiConsent(
  recipient: AiRecipient,
  privacyUrl = AI_PRIVACY_URL,
): Promise<boolean> {
  return new Promise((resolve) => {
    const show = () =>
      Alert.alert(
        `Share data with ${recipient.name}?`,
        [
          recipient.detail,
          AI_DATA_DISCLOSURES[recipient.use],
          "You can withdraw permission for new mobile actions in Account → AI data sharing.",
        ]
          .filter(Boolean)
          .join("\n\n"),
        [
          { text: "Not now", style: "cancel", onPress: () => resolve(false) },
          {
            text: "Privacy policy",
            onPress: () => {
              void Linking.openURL(privacyUrl).finally(show);
            },
          },
          { text: "Allow", onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      );
    show();
  });
}
