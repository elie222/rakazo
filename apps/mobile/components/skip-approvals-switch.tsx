import type { ActionAutoReviewSettings } from "@rakazo/contracts";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "react-native";
import { useI18n } from "../lib/i18n";
import type { SettingsTarget } from "../lib/settings-target";
import { settingsRpc } from "../lib/settings-target";
import { errorText } from "../lib/user-error";
import { SettingsSwitch } from "./settings-group";

/** Whether bots run actions without asking, for the account or one Space's override. */
export function SkipApprovalsSwitch({ target }: { target: SettingsTarget }) {
  const { t } = useI18n();
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const [settings, setSettings] = useState<ActionAutoReviewSettings | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let current = true;
    void rpc<ActionAutoReviewSettings>("autoReview/get", { scope: target.scope })
      .then((next) => {
        if (current) setSettings(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [rpc, target.scope]);

  function setSkipApprovals(skipApprovals: boolean) {
    setPending(true);
    void rpc<ActionAutoReviewSettings>("autoReview/set", { skipApprovals, scope: target.scope })
      .then(setSettings)
      .catch((cause: unknown) => Alert.alert(t("Run actions without asking"), errorText(cause)))
      .finally(() => setPending(false));
  }

  return (
    <SettingsSwitch
      label={t("Run actions without asking")}
      value={settings?.skipApprovals ?? false}
      disabled={!settings || pending}
      onChange={setSkipApprovals}
    />
  );
}
