import { Alert } from "react-native";

const PASSKEY_NAME_MAX_LENGTH = 100;

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
          const name = value?.trim().slice(0, PASSKEY_NAME_MAX_LENGTH);
          if (name && name !== input.defaultValue) input.onSubmit(name);
        },
      },
    ],
    "plain-text",
    input.defaultValue,
  );
}
