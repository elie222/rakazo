import { t } from "@lingui/core/macro";
import type { ComputerMode } from "@rakazo/contracts";
import { Alert } from "react-native";
import { rpc } from "../api/api";

/** What happens to a bot's files when it moves to another computer. */
export type ComputerMoveFiles = "bring" | "leave";

/**
 * Asks, before a bot moves to `mode`, whether its files come along. Resolves null when the
 * question is dismissed, which leaves the bot where it is.
 */
export async function askComputerMoveFiles(input: {
  botId: string;
  botName: string;
  mode: ComputerMode;
}): Promise<ComputerMoveFiles | null> {
  const { botName, mode } = input;
  // The question is still asked when the server cannot say what the other computer holds.
  const replaces = await rpc("bots/computerMove", { botId: input.botId, mode }).then(
    (move) => move.replacesFiles,
    () => false,
  );
  const message = !replaces
    ? undefined
    : mode === "dedicated"
      ? t`They replace the older files on its own computer.`
      : t`They replace the older files on the Team Computer.`;
  return new Promise((resolve) => {
    Alert.alert(
      mode === "dedicated"
        ? t`Bring ${botName}'s files from the Team Computer?`
        : t`Bring ${botName}'s files from its own computer?`,
      message,
      [
        { text: t`Cancel`, style: "cancel", onPress: () => resolve(null) },
        { text: t`Start empty`, onPress: () => resolve("leave") },
        { text: t`Bring files`, isPreferred: true, onPress: () => resolve("bring") },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}
