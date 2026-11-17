import { Alert, Platform } from "react-native";

type AccountDeletionPrompt = {
  title: string;
  message: string;
  cancelLabel: string;
  deleteLabel: string;
  onSubmit: (password: string) => void;
};

/**
 * Asks for the current password before deleting an account.
 * iOS uses the system secure prompt. Other platforms return false so the screen
 * can show its own single-field dialog (Alert.prompt is iOS-only).
 */
export function promptAccountDeletion(input: AccountDeletionPrompt): boolean {
  if (Platform.OS !== "ios") return false;
  Alert.prompt(
    input.title,
    input.message,
    [
      { text: input.cancelLabel, style: "cancel" },
      {
        text: input.deleteLabel,
        style: "destructive",
        onPress: (value?: string) => {
          if (!value) return;
          input.onSubmit(value);
        },
      },
    ],
    "secure-text",
  );
  return true;
}
