import { ph, t } from "@lingui/core/macro";
import type { AiDataUse, AiRecipient } from "@rakazo/contracts";
import { Alert } from "react-native";

/** What a provider receives for one use of AI data, in full, for the settings screen. */
export function aiDataDisclosure(use: AiDataUse): string {
  switch (use) {
    case "model":
      return t`Messages, chat history, bot instructions, memories, attachments, screenshots and connected-app content are sent to run your bots, including routines.`;
    case "voice":
      return t`Your recordings are sent for transcription, and text you play is sent to generate speech.`;
    case "memory":
      return t`Conversations, names, memories, searches and bot and Space IDs are sent to store and recall context.`;
  }
}

/** The one-line version shown when asking; the settings screen carries the full list. */
function consentSummary(use: AiDataUse): string {
  switch (use) {
    case "model":
      return t`Messages, files, bot instructions, memories and connected-app content are sent to run your bots.`;
    case "voice":
      return t`Your recordings and the text you play are sent for transcription and speech.`;
    case "memory":
      return t`Conversations, names and searches are sent to store and recall context.`;
  }
}

export function promptAiConsent(recipient: AiRecipient): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(allowed);
    };
    Alert.alert(
      t`Send data to ${ph({ name: recipient.name })}?`,
      consentSummary(recipient.use),
      [
        { text: t`Not now`, style: "cancel", onPress: () => finish(false) },
        { text: t`Allow`, onPress: () => finish(true) },
      ],
      // Android dismisses on an outside tap without a button callback.
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}
