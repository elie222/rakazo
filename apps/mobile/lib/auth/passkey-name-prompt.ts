import { Alert } from "react-native";

/** Uses the iOS system prompt with the same 100-character limit as web passkey names. */
export function promptPasskeyName(input: {
  title: string;
  cancelLabel: string;
  submitLabel: string;
  defaultValue?: string;
  onSubmit: (name: string) => void;
}) {
  Alert.prompt(
    input.title,
    undefined,
    [
      { text: input.cancelLabel, style: "cancel" },
      {
        text: input.submitLabel,
        onPress: (value?: string) => {
          const name = value?.trim().slice(0, 100);
          if (name && name !== input.defaultValue) input.onSubmit(name);
        },
      },
    ],
    "plain-text",
    input.defaultValue,
  );
}
