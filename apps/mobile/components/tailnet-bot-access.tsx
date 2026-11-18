import { useLingui } from "@lingui/react/macro";
import { Alert } from "react-native";
import { errorText } from "../lib/api/user-error";
import { queryClient, rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { SettingsGroup, SettingsSwitch } from "./settings/settings-group";

/**
 * Lets this bot reach the member's own tailnet in this Space. It shows only once they have
 * connected one, which is done on web or desktop.
 */
export function TailnetBotAccess({ botId }: { botId: string }) {
  const { t } = useLingui();
  const statusRead = rpcQuery("tailnet/status");
  const status = useScreenQuery(statusRead).data;
  const change = useSave({
    save: async (enabled: boolean, send) => {
      // The answer is the status as saved, so the switch keeps it if a later read fails.
      queryClient.setQueryData(
        statusRead.queryKey,
        await send("tailnet/setBotAccess", { botId, enabled }),
      );
    },
    onFailed: (cause) =>
      Alert.alert(t`Tailnet`, errorText(cause, t`Couldn't update tailnet access`)),
  });
  const connection = status && !status.unavailable ? status.connection : null;
  if (!connection) return null;
  // The switch shows the change being saved until the answer is back.
  const allowed = change.pending ? change.input : connection.botIds.includes(botId);

  return (
    <SettingsGroup label={t`Tailnet`}>
      <SettingsSwitch
        label={t`Reach machines on your tailnet`}
        value={Boolean(allowed)}
        disabled={change.pending}
        onChange={(enabled) => change.run(enabled)}
      />
    </SettingsGroup>
  );
}
