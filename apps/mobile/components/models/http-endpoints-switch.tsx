import { useLingui } from "@lingui/react/macro";
import { Alert } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { SettingsSwitch } from "../settings/settings-group";

/**
 * The deployment's plain-HTTP model endpoints switch, shown to admins inside the compatible
 * endpoint's Advanced section. The server re-checks the setting on every connect and every run.
 */
export function HttpEndpointsSwitch() {
  const { t } = useLingui();
  const me = useScreenQuery(rpcQuery("me"));
  const settingRead = rpcQuery("models/httpEndpointsAllowed");
  // The RPC refuses anyone but an admin, so a member never asks for it.
  const setting = useScreenQuery(settingRead, { enabled: me.data?.isAdmin === true });
  const save = useSave({
    save: (allowed: boolean, send) => send("models/setHttpEndpointsAllowed", { allowed }),
    stale: [settingRead.queryKey],
    onFailed: (error) =>
      Alert.alert(t`Plain-HTTP endpoints`, errorText(error, t`Couldn't update this setting.`)),
  });
  if (me.data?.isAdmin !== true) return null;
  return (
    <SettingsSwitch
      label={t`Allow plain-HTTP endpoints`}
      detail={t`Members can connect model servers that do not use TLS. API keys are sent to those servers unencrypted; only enable this on a trusted network.`}
      value={setting.data?.allowed === true}
      disabled={setting.isPending || setting.isError || save.pending}
      onChange={(allowed) => save.run(allowed)}
    />
  );
}
