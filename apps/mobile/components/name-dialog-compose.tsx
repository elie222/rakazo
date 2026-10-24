import {
  AlertDialog,
  Host,
  OutlinedTextField,
  Text,
  TextButton,
  useNativeState,
} from "@expo/ui/jetpack-compose";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";
import type { NameDialogProps } from "./name-dialog";

export default function ComposeNameDialog({
  draft,
  error,
  saving,
  onChange,
  onSave,
  onClose,
}: NameDialogProps) {
  const { t } = useI18n();
  const scheme = useResolvedAppearance();
  const tokens = tokensForAppearance(scheme);
  const value = useNativeState(draft);
  const selection = useNativeState({ start: 0, end: draft.length });
  // Follow the app's monochrome accent instead of a palette generated from it.
  const buttonColors = {
    contentColor: tokens.foreground,
    disabledContentColor: tokens.mutedForeground,
  };
  return (
    <Host
      useViewportSizeMeasurement
      colorScheme={scheme}
      seedColor={tokens.primary}
      style={{ position: "absolute", width: 0, height: 0 }}
    >
      <AlertDialog
        onDismissRequest={onClose}
        colors={{ containerColor: tokens.card, titleContentColor: tokens.foreground }}
      >
        <AlertDialog.Title>
          <Text style={{ typography: "headlineSmall" }}>{t("Edit name")}</Text>
        </AlertDialog.Title>
        <AlertDialog.Text>
          <OutlinedTextField
            value={value}
            selection={selection}
            autoFocus
            singleLine
            maxLength={80}
            enabled={!saving}
            isError={!!error}
            onValueChange={onChange}
            textSelectionColors={{
              handleColor: tokens.foreground,
              backgroundColor: `${tokens.foreground}33`,
            }}
            colors={{
              focusedTextColor: tokens.foreground,
              unfocusedTextColor: tokens.foreground,
              cursorColor: tokens.foreground,
              focusedIndicatorColor: tokens.foreground,
              unfocusedIndicatorColor: tokens.mutedForeground,
              focusedLabelColor: tokens.foreground,
              unfocusedLabelColor: tokens.mutedForeground,
              errorIndicatorColor: tokens.destructive,
              errorLabelColor: tokens.destructive,
              errorSupportingTextColor: tokens.destructive,
              errorCursorColor: tokens.destructive,
            }}
            keyboardOptions={{ capitalization: "words", imeAction: "done" }}
            keyboardActions={{
              onDone: (text) => {
                if (!saving && text.trim()) onSave(text);
              },
            }}
          >
            <OutlinedTextField.Label>
              <Text>{t("Name")}</Text>
            </OutlinedTextField.Label>
            {error ? (
              <OutlinedTextField.SupportingText>
                <Text>{error}</Text>
              </OutlinedTextField.SupportingText>
            ) : null}
          </OutlinedTextField>
        </AlertDialog.Text>
        <AlertDialog.ConfirmButton>
          <TextButton
            colors={buttonColors}
            enabled={!saving && !!draft.trim()}
            onClick={() => onSave(value.value)}
          >
            <Text>{t("Save")}</Text>
          </TextButton>
        </AlertDialog.ConfirmButton>
        <AlertDialog.DismissButton>
          <TextButton colors={buttonColors} enabled={!saving} onClick={onClose}>
            <Text>{t("Cancel")}</Text>
          </TextButton>
        </AlertDialog.DismissButton>
      </AlertDialog>
    </Host>
  );
}
