import { useLingui } from "@lingui/react/macro";
import { Image, Modal, StyleSheet, Text, View } from "react-native";
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView,
} from "react-native-safe-area-context";
import { useMobileTokens } from "../../lib/native/native";
import { GlassIconButton } from "../native/glass-icon-button";

/** A full-screen still of a screen region, kept native so it can be dismissed by the system. */
export function ComputerZoomModal({
  image,
  onClose,
}: {
  image: string | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  return (
    <Modal
      visible={image !== null}
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: tokens.foreground }]}>{t`Zoomed screen`}</Text>
            <GlassIconButton
              accessibilityLabel={t`Close zoom`}
              onPress={onClose}
              ios="xmark"
              android="close"
              size={36}
              iconSize={16}
            />
          </View>
          {image ? (
            <Image source={{ uri: image }} style={styles.image} resizeMode="contain" />
          ) : null}
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 17, fontWeight: "600" },
  image: { flex: 1 },
});
