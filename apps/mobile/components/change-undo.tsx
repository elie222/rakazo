import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { useMobileTokens } from "../lib/native";
import { useSave } from "../lib/query";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

/** Instructions or settings a bot changed from chat, which the user can undo. */
export function isUndoableChange(block: MessageBlock): boolean {
  return (
    block.kind === "ask" && Boolean(block.instructionUpdate?.undoVersionId || block.settingsUpdate)
  );
}

export function ChangeUndo({ block }: { block: AskBlock }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [restored, setRestored] = useState(false);
  const { instructionUpdate, settingsUpdate } = block;
  const undo = useSave({
    save: async (_, send) => {
      if (instructionUpdate?.undoVersionId)
        await send("bots/restoreInstructions", {
          botId: instructionUpdate.botId,
          versionId: instructionUpdate.undoVersionId,
          expectedInstructions: instructionUpdate.after,
          undo: true,
        });
      else if (settingsUpdate)
        await send("bots/update", {
          botId: settingsUpdate.botId,
          ...settingsUpdate.before,
          expectedSettings: settingsUpdate.after,
        });
    },
    onSaved: () => setRestored(true),
    onFailed: (error) => Alert.alert(errorText(error)),
  });
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ color: tokens.foreground }}>
        {instructionUpdate ? t`Instructions updated` : t`Settings updated`}
      </Text>
      <NativeActionButton
        label={restored ? t`Restored` : t`Undo`}
        prominence="plain"
        size="compact"
        disabled={undo.pending || restored}
        onPress={() => undo.run()}
      />
    </View>
  );
}
