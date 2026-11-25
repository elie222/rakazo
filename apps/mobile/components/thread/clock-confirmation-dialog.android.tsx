import { AlertDialog, Host, Text, TextButton } from "@expo/ui/jetpack-compose";
import { useLingui } from "@lingui/react/macro";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import { useResolvedAppearance } from "../../lib/native/native";
import type { ClockPrompt } from "../../lib/phone-clock/use-clock-confirmation";

export function ClockConfirmationDialog({ prompt }: { prompt: ClockPrompt }) {
  const { t } = useLingui();
  const scheme = useResolvedAppearance();
  const tokens = tokensForAppearance(scheme);
  const buttonColors = { contentColor: tokens.foreground };
  return (
    <Host
      useViewportSizeMeasurement
      colorScheme={scheme}
      seedColor={tokens.primary}
      style={{ position: "absolute", width: 0, height: 0 }}
    >
      <AlertDialog
        onDismissRequest={() => prompt.settle(false)}
        colors={{
          containerColor: tokens.card,
          titleContentColor: tokens.foreground,
          textContentColor: tokens.foreground,
        }}
      >
        <AlertDialog.Title>
          <Text style={{ typography: "headlineSmall" }}>{prompt.title}</Text>
        </AlertDialog.Title>
        <AlertDialog.Text>
          <Text>{prompt.message}</Text>
        </AlertDialog.Text>
        <AlertDialog.ConfirmButton>
          <TextButton colors={buttonColors} onClick={() => prompt.settle(true)}>
            <Text>{t`Open Clock`}</Text>
          </TextButton>
        </AlertDialog.ConfirmButton>
        <AlertDialog.DismissButton>
          <TextButton colors={buttonColors} onClick={() => prompt.settle(false)}>
            <Text>{t`Cancel`}</Text>
          </TextButton>
        </AlertDialog.DismissButton>
      </AlertDialog>
    </Host>
  );
}
