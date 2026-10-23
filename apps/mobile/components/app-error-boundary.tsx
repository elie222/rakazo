import * as SplashScreen from "expo-splash-screen";
import type { ReactNode } from "react";
import { Component } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { t } from "../lib/i18n";
import { reportMobileError } from "../lib/monitoring";
import { completeMobileStartup } from "../lib/startup";

type Props = { children: ReactNode };
type State = { failed: boolean };

/** Keep a render failure from becoming a blank release screen. */
export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error) {
    reportMobileError(error, "react.render");
    void SplashScreen.hideAsync()
      .then(completeMobileStartup)
      .catch(() => undefined);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    const tokens = mobileTokens();
    return (
      <View style={[styles.screen, { backgroundColor: tokens.background }]}>
        <Pressable
          accessibilityRole="button"
          onPress={() => this.setState({ failed: false })}
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: tokens.primary, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.actionText, { color: tokens.primaryForeground }]}>
            {t("Try again")}
          </Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18, padding: 28 },
  action: { borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12 },
  actionText: { fontSize: 15, fontWeight: "600" },
});
