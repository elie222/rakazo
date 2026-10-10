import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

export function InstructionUndo({
  botId,
  versionId,
  instructions,
}: {
  botId: string;
  versionId: string;
  instructions: string;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [pending, setPending] = useState(false);
  const [restored, setRestored] = useState(false);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ color: tokens.foreground }}>{t("Instructions updated")} ·</Text>
      <NativeActionButton
        label={t(restored ? "Restored" : "Undo")}
        disabled={pending || restored}
        onPress={async () => {
          setPending(true);
          try {
            await rpc("bots/restoreInstructions", {
              botId,
              versionId,
              expectedInstructions: instructions,
            });
            setRestored(true);
          } catch {
            Alert.alert(t("Could not restore instructions"));
          } finally {
            setPending(false);
          }
        }}
      />
    </View>
  );
}
