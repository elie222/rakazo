import { requireNativeView, requireOptionalNativeModule } from "expo";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

type NativePdfViewProps = {
  uri: string;
  onLoadError: () => void;
  accessibilityLabel: string;
  style?: object;
};

// PDFKit on iOS, PdfRenderer on Android: Android's WebView cannot show a PDF at all. An
// over-the-air update can reach a build made before this view existed, which gets the fallback.
const NativePdfView = requireOptionalNativeModule("RakazoPdfView")
  ? requireNativeView<NativePdfViewProps>("RakazoPdfView")
  : null;

/** A local PDF file shown in the app, so reading one never needs another app. */
export function PdfPreview({ uri, name }: { uri: string; name: string }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [failed, setFailed] = useState(false);
  if (failed || !NativePdfView) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{t("Could not open this PDF.")}</Text>
      </View>
    );
  }
  return (
    <NativePdfView
      accessibilityLabel={name}
      uri={uri}
      onLoadError={() => setFailed(true)}
      style={styles.fill}
    />
  );
}

function createStyles() {
  return StyleSheet.create({
    fill: { flex: 1, backgroundColor: native.fill },
    centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
    error: { color: native.secondaryLabel, fontSize: 14, textAlign: "center" },
  });
}
