import { useLingui } from "@lingui/react/macro";
import type { LabFeature } from "@rakazo/contracts";
import { LAB_FEATURES, withLab } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SettingsGroup, SettingsSwitch, useStackedSettings } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import type { MobileMe } from "../../lib/mobile-types";
import { useThemedStyles } from "../../lib/native";
import { createSettingsPageStyles } from "../../lib/settings-page-styles";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

export default function Labs() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const styles = useThemedStyles(createSettingsPageStyles);
  const stacked = useStackedSettings();
  const [labs, setLabs] = useState<MobileMe["labs"] | null>(null);
  const saveRequest = useRef(0);
  const labels: Record<LabFeature, string> = { board: t`Board` };

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void rpc("me")
        .then((me) => {
          if (active) setLabs(me.labs);
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, []),
  );

  function toggle(feature: LabFeature, enabled: boolean) {
    if (!labs) return;
    const previous = labs;
    const next = withLab(previous, feature, enabled);
    // Only the latest tap's reply may land, so a slower earlier save can't undo it.
    const request = ++saveRequest.current;
    setLabs(next);
    rpc("preferences/update", { labs: next })
      .then((me) => {
        if (request === saveRequest.current) setLabs(me.labs);
      })
      .catch((cause: unknown) => {
        if (request !== saveRequest.current) return;
        setLabs(previous);
        Alert.alert(t`Labs`, errorText(cause, t`Could not save`));
      });
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
            {LAB_FEATURES.map((feature) => (
              <SettingsSwitch
                key={feature}
                label={labels[feature]}
                value={labs.includes(feature)}
                onChange={(enabled) => toggle(feature, enabled)}
              />
            ))}
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
