import { useLingui } from "@lingui/react/macro";
import type { LabFeature } from "@rakazo/contracts";
import { withLab } from "@rakazo/contracts";
import { Alert, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  SettingsGroup,
  SettingsSwitch,
  useStackedSettings,
} from "../../components/settings/settings-group";
import { errorText } from "../../lib/api/user-error";
import { useSideInsets } from "../../lib/layout/side-insets";
import { useThemedStyles } from "../../lib/native/native";
import { accountRpcQuery, queryClient, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { ACCOUNT_SETTINGS } from "../../lib/query/settings-target";
import { createSettingsPageStyles } from "../../lib/settings/settings-page-styles";

export default function Labs() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const styles = useThemedStyles(createSettingsPageStyles);
  const stacked = useStackedSettings();
  const copy: Record<LabFeature, { title: string; detail: string }> = {
    board: { title: t`Board`, detail: t`A kanban board of tickets your bots can work on` },
  };
  const meRead = accountRpcQuery("me");
  const me = useScreenQuery(meRead).data;
  const change = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (labs: LabFeature[], send) => {
      // The answer is the account as saved, so the switch keeps it if the read after it fails.
      queryClient.setQueryData(meRead.queryKey, await send("preferences/update", { labs }));
    },
    stale: [meRead.queryKey],
    onFailed: (cause) => Alert.alert(t`Labs`, errorText(cause, t`Could not save`)),
  });
  // The switch shows the change being saved until the read after it is back.
  const labs = change.pending ? change.input : me?.labs;
  const available = me?.labsAvailable ?? [];

  function toggle(feature: LabFeature, enabled: boolean) {
    if (labs) change.run(withLab(labs, feature, enabled));
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={[styles.content, stacked && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
      >
        {labs ? (
          <SettingsGroup>
            {available.map((feature) => (
              <SettingsSwitch
                key={feature}
                label={copy[feature].title}
                detail={copy[feature].detail}
                value={labs.includes(feature)}
                disabled={change.pending}
                onChange={(enabled) => toggle(feature, enabled)}
              />
            ))}
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
