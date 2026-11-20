import { BOT_SECTION_NAME_MAX_LENGTH } from "@rakazo/contracts";
import { truncatePlainText } from "@rakazo/core";
import { Alert } from "react-native";

/**
 * Asks for a section name with the iOS system prompt (Alert.prompt is iOS-only). Empty and
 * unchanged names are ignored.
 */
export function promptSectionName(input: {
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
          const text = value?.trim() ?? "";
          const name = truncatePlainText(text, BOT_SECTION_NAME_MAX_LENGTH).trimEnd();
          if (name && name !== input.defaultValue) input.onSubmit(name);
        },
      },
    ],
    "plain-text",
    input.defaultValue,
  );
}
