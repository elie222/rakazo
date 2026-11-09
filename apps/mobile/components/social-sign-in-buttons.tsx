import type { ReactNode } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

/**
 * Provider choices for the first sign-in screen. Google and Apple are the
 * primary actions; email is a quieter step underneath. One provider spans
 * the row. Narrow widths stack the pair so the labels stay intact. The Apple
 * control matches Apple's button and still starts the system sheet.
 */
export function SocialSignInButtons({
  providers,
  disabled,
  onPress,
  onEmail,
}: {
  providers: { id: string; name: string }[];
  disabled?: boolean;
  onPress: (providerId: string) => void;
  onEmail?: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const scheme = useResolvedAppearance();
  const { width } = useWindowDimensions();
  if (providers.length === 0 && !onEmail) return null;
  const row = providers.length > 1 && width >= 720;
  const dark = scheme === "dark";
  return (
    <View style={{ marginTop: 8, gap: 0 }}>
      {providers.length > 0 ? (
        <View style={{ flexDirection: row ? "row" : "column", gap: 12 }}>
          {providers.map((provider) => (
            <Choice
              key={provider.id}
              label={t("Continue with {name}", { name: provider.name })}
              disabled={disabled}
              onPress={() => onPress(provider.id)}
              fill={!row}
              style={providerStyle(provider.id, dark, tokens)}
              mark={
                provider.id === "google" ? (
                  <GoogleMark />
                ) : provider.id === "apple" ? (
                  <AppleMark color={dark ? "black" : "white"} />
                ) : null
              }
            />
          ))}
        </View>
      ) : null}
      {onEmail ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 18 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: tokens.border }} />
            <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{t("or")}</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: tokens.border }} />
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={onEmail}
            style={{
              alignSelf: "center",
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              marginTop: 10,
              minHeight: 32,
              paddingHorizontal: 8,
              opacity: disabled ? 0.45 : 1,
            }}
          >
            <MailMark color={tokens.mutedForeground} />
            <Text style={{ color: tokens.mutedForeground, fontSize: 14, fontWeight: "500" }}>
              {t("Continue with email")}
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

function providerStyle(
  id: string,
  dark: boolean,
  tokens: ReturnType<typeof useMobileTokens>,
): { backgroundColor: string; borderColor: string; color: string } {
  if (id === "apple") {
    return dark
      ? { backgroundColor: "white", borderColor: "white", color: "black" }
      : { backgroundColor: "black", borderColor: "black", color: "white" };
  }
  if (id === "google") {
    return dark
      ? { backgroundColor: tokens.background, borderColor: tokens.border, color: tokens.foreground }
      : { backgroundColor: "white", borderColor: tokens.border, color: "black" };
  }
  return {
    backgroundColor: tokens.foreground,
    borderColor: tokens.foreground,
    color: tokens.background,
  };
}

function Choice({
  label,
  disabled,
  onPress,
  mark,
  fill,
  style,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  mark: ReactNode;
  fill?: boolean;
  style: { backgroundColor: string; borderColor: string; color: string };
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={{
        flex: fill ? undefined : 1,
        alignSelf: fill ? "stretch" : undefined,
        minHeight: 48,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: style.borderColor,
        backgroundColor: style.backgroundColor,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        paddingHorizontal: 16,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {mark}
      <Text numberOfLines={1} style={{ color: style.color, fontSize: 16, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

function GoogleMark() {
  return (
    <Svg width={20} height={20} viewBox="0 0 48 48">
      <Path
        fill={logoColor("FFC107")}
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <Path
        fill={logoColor("FF3D00")}
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <Path
        fill={logoColor("4CAF50")}
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0124 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <Path
        fill={logoColor("1976D2")}
        d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </Svg>
  );
}

/** The Google mark uses its own colors. They are not product theme tokens. */
function logoColor(digits: string) {
  return `#${digits}`;
}

function AppleMark({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        fill={color}
        d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"
      />
    </Svg>
  );
}

function MailMark({ color }: { color: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 7.2C4 6 5 5 6.2 5h11.6C19 5 20 6 20 7.2v9.6c0 1.2-1 2.2-2.2 2.2H6.2C5 19 4 18 4 16.8V7.2Z"
        stroke={color}
        strokeWidth="1.8"
      />
      <Path d="M4.6 7.4 12 13l7.4-5.6" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}
