import { normalizeRunError } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { useEffect, useReducer, useState } from "react";
import { Platform, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { parseRunDiagnostic, runErrorWhatHappened } from "../lib/run-error-presentation";
import { NativeSymbol } from "./native-symbol";
import { RunErrorAction, RunErrorTextAction } from "./run-error-actions";
import { RunErrorSheetContainer } from "./run-error-sheet-container";
import { SheetCloseButton } from "./sheet-close-button";

/** Saved provider diagnostics do not identify the credential owner. */
export function useRunError(details: string | null, includeReset = true) {
  const { t, locale } = useI18n();
  const [clockVersion, refreshClock] = useReducer((version: number) => version + 1, 0);
  const error = details
    ? normalizeRunError(
        details,
        (message, values) => {
          if (!includeReset && message === "{summary} Resets {date}.")
            return String(values?.summary ?? "");
          if (message === "Your OpenRouter") return "OpenRouter";
          if (message === "Your OpenAI") return "OpenAI";
          if (message === "Your Anthropic") return "Anthropic";
          if (message === "Your model provider") return t("Model provider");
          return t(message, values);
        },
        locale,
        Date.now(),
      )
    : null;
  useEffect(() => {
    if (!error?.resetAt) return;
    const timer = setTimeout(
      refreshClock,
      Math.min(2_147_483_647, Math.max(0, error.resetAt - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [error?.resetAt, clockVersion]);
  return error;
}

export function RunErrorSheet({
  details,
  onClose,
  action,
}: {
  details: string | null;
  onClose: () => void;
  /** The one action that fixes the failure. */
  action?: { label: string; onPress: () => void } | null;
}) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const { fontScale, height } = useWindowDimensions();
  const error = useRunError(details, false);
  const [technical, setTechnical] = useState(false);
  useEffect(() => setTechnical(false), [details]);
  if (!error) return null;
  const diagnostic = parseRunDiagnostic(error.details, locale);
  const textStyle = { color: tokens.foreground, fontSize: 16, lineHeight: 24 };
  return (
    <RunErrorSheetContainer onClose={onClose} expanded={technical} label={error.summary}>
      <View
        accessibilityViewIsModal
        style={{
          flex: Platform.OS === "ios" ? undefined : 1,
          backgroundColor: tokens.background,
          paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
          paddingBottom: Platform.OS === "ios" ? 0 : insets.bottom,
        }}
      >
        {/* Keep the close target inside the scroll bounds without moving the headline. */}
        {/* Android's native sheet wraps this in its own scroll view, so nested scrolling must be on. */}
        <ScrollView
          nestedScrollEnabled
          style={{ flexGrow: 0, maxHeight: height * 0.9 - 28, marginTop: -11 }}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 11,
            paddingBottom: 16,
            gap: 16,
          }}
        >
          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", minHeight: 30 }}>
            <View style={{ paddingTop: 2.5 * fontScale }}>
              <NativeSymbol
                ios="exclamationmark.triangle.fill"
                android="warning"
                size={17 * fontScale}
                color={tokens.warning}
              />
            </View>
            <Text
              style={{
                flex: 1,
                color: tokens.foreground,
                fontSize: 17,
                lineHeight: 22,
                fontWeight: "600",
              }}
            >
              {error.summary}
            </Text>
            <View
              style={{
                height: 22 * fontScale,
                justifyContent: "center",
                transform: [{ translateY: 1.5 * fontScale }],
              }}
            >
              <SheetCloseButton onPress={onClose} />
            </View>
          </View>
          <Text style={{ color: tokens.mutedForeground, fontSize: 15, lineHeight: 21 }}>
            {runErrorWhatHappened(t, error)}
          </Text>
          {action ? <RunErrorAction label={action.label} onPress={action.onPress} /> : null}
          <RunErrorTextAction
            label={t("Technical details")}
            expanded={technical}
            onPress={() => setTechnical(!technical)}
          />
          {technical ? (
            <>
              {[
                [t("Status"), diagnostic.status],
                [t("Provider message"), diagnostic.message],
                [t("Limit"), diagnostic.limit],
                [t("Resets"), diagnostic.resets],
              ].map(([label, value]) =>
                value ? (
                  <View key={label} style={{ gap: 4 }}>
                    <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{label}</Text>
                    <Text selectable style={textStyle}>
                      {value}
                    </Text>
                  </View>
                ) : null,
              )}
              <RunErrorTextAction
                label={t("Copy")}
                onPress={() => {
                  void Clipboard.setStringAsync(details ?? "");
                }}
              />
            </>
          ) : null}
        </ScrollView>
      </View>
    </RunErrorSheetContainer>
  );
}
