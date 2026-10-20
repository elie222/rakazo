import { useEffect, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { NativeActionButton } from "./native-action-button";

/** Intrinsic button widths wrap together; each wrapped button fills its row. */
export function RunErrorActions({
  onConnection,
  onModel,
}: {
  onConnection?: () => void;
  onModel?: () => void;
}) {
  const { t, locale } = useI18n();
  const { width, fontScale } = useWindowDimensions();
  const [wrapped, setWrapped] = useState(false);
  const [actionWidth, setActionWidth] = useState(0);
  useEffect(() => setWrapped(false), [width, fontScale, locale]);
  const stacked = wrapped || fontScale > 1.3;
  return (
    <View
      style={styles.actions}
      onLayout={({ nativeEvent }) => {
        setActionWidth(nativeEvent.layout.width);
        // Native intrinsic widths include translated labels. Once they wrap, fill both rows.
        if (!stacked && nativeEvent.layout.height >= 2 * 44) setWrapped(true);
      }}
    >
      {[
        { label: t("Set your own key"), onPress: onConnection, primary: true },
        { label: t("Change model"), onPress: onModel, primary: false },
      ].map(({ label, onPress, primary }) =>
        onPress ? (
          <NativeActionButton
            key={label}
            label={label}
            onPress={onPress}
            prominence={primary ? "primary" : "secondary"}
            variant="rectangular"
            fill={stacked}
            style={{
              width: stacked && actionWidth ? actionWidth : undefined,
              flexBasis: stacked ? "100%" : "auto",
            }}
          />
        ) : null,
      )}
    </View>
  );
}

export function RunErrorTextAction({
  label,
  onPress,
  expanded,
}: {
  label: string;
  onPress: () => void;
  expanded?: boolean;
}) {
  return (
    <NativeActionButton
      variant="text"
      label={label}
      onPress={onPress}
      fill={false}
      icon={
        expanded === undefined
          ? undefined
          : {
              ios: expanded ? "chevron.down" : "chevron.right",
              android: expanded ? "chevron-down" : "chevron-forward",
            }
      }
    />
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "stretch" },
});
