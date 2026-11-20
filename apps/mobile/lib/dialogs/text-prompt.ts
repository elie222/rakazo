import { t } from "@lingui/core/macro";
import type { Alert } from "react-native";

export function lengthLimitMessage(maxLength: number): string {
  return t`Use ${maxLength} characters or fewer`;
}

export function promptText(
  alert: Pick<typeof Alert, "prompt">,
  input: {
    title: string;
    message?: string;
    value: string;
    onSave: (value: string) => void;
  },
) {
  alert.prompt(
    input.title,
    input.message,
    [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Save`,
        isPreferred: true,
        onPress: (value?: string) => input.onSave(value ?? input.value),
      },
    ],
    "plain-text",
    input.value,
  );
}
