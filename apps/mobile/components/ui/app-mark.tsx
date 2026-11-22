import { Image, StyleSheet } from "react-native";
import appMark from "../../assets/app-mark.png";
import { native, useThemedStyles } from "../../lib/native/native";

const MARK = 60;

/** The app icon as the home screen shows it, for the about footer. */
export function AppMark() {
  const styles = useThemedStyles(createAppMarkStyles);
  return (
    <Image
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      source={appMark}
      style={styles.icon}
    />
  );
}

function createAppMarkStyles() {
  return StyleSheet.create({
    icon: {
      width: MARK,
      height: MARK,
      // The iOS icon mask: about 22% corners on the continuous curve.
      borderRadius: MARK * 0.225,
      borderCurve: "continuous",
      // Keeps the icon's dark edge from melting into a dark page.
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: native.separator,
      overflow: "hidden",
      alignSelf: "center",
    },
  });
}
