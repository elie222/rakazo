import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { SignInProvider } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { NativeProviderButton } from "../lib/native-provider-button";

export function SocialSignInButtons({
  providers,
  disabled,
  onPress,
  onEmail,
}: {
  providers: SignInProvider[];
  disabled?: boolean;
  onPress: (providerId: string) => void;
  onEmail?: () => void;
}) {
  const { t } = useLingui();
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
            <NativeProviderButton
              key={provider.id}
              provider={provider}
              disabled={disabled}
              dark={dark}
              onPress={() => onPress(provider.id)}
              fill={!row}
            >
              <Choice
                label={t`Continue with ${ph({ name: provider.name })}`}
                disabled={disabled}
                onPress={() => onPress(provider.id)}
                fill={!row}
                style={providerStyle(provider.presentation?.variant, tokens)}
                mark={
                  provider.presentation?.mark ? (
                    <Svg width={20} height={20} viewBox={provider.presentation.mark.viewBox}>
                      {provider.presentation.mark.paths.map((path) => (
                        <Path
                          key={path.d}
                          d={path.d}
                          fill={
                            path.fill === "currentColor"
                              ? provider.presentation?.variant === "outline"
                                ? tokens.foreground
                                : tokens.primaryForeground
                              : path.fill
                          }
                        />
                      ))}
                    </Svg>
                  ) : null
                }
              />
            </NativeProviderButton>
          ))}
        </View>
      ) : null}
      {onEmail ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 18 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: tokens.border }} />
            <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{t`or`}</Text>
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
              {t`Continue with email`}
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

function providerStyle(variant: string | undefined, tokens: ReturnType<typeof useMobileTokens>) {
  return variant === "outline"
    ? { backgroundColor: tokens.background, borderColor: tokens.border, color: tokens.foreground }
    : {
        backgroundColor: tokens.primary,
        borderColor: tokens.primary,
        color: tokens.primaryForeground,
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
