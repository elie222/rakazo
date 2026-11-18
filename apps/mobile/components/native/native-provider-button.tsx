import type { SignInProvider } from "@rakazo/contracts";
import type * as AppleAuthentication from "expo-apple-authentication";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Platform, View } from "react-native";

/** The platform adapter owns vendor-specific native controls. */
export function NativeProviderButton({
  provider,
  disabled,
  dark,
  onPress,
  fill,
  children,
}: {
  provider: SignInProvider;
  disabled?: boolean;
  dark: boolean;
  onPress: () => void;
  fill: boolean;
  children: ReactNode;
}) {
  const [native, setNative] = useState<typeof AppleAuthentication | null>(null);
  useEffect(() => {
    let active = true;
    setNative(null);
    if (Platform.OS === "ios" && provider.id === "apple") {
      void import("expo-apple-authentication")
        .then(async (module) => {
          if (await module.isAvailableAsync()) {
            if (active) setNative(module);
          }
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [provider.id]);
  if (!native) return children;
  return (
    <View
      pointerEvents={disabled ? "none" : "auto"}
      accessibilityState={{ disabled }}
      style={{ flex: fill ? undefined : 1, opacity: disabled ? 0.45 : 1 }}
    >
      <native.AppleAuthenticationButton
        buttonType={native.AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={
          dark
            ? native.AppleAuthenticationButtonStyle.WHITE
            : native.AppleAuthenticationButtonStyle.BLACK
        }
        cornerRadius={12}
        style={{ height: 48, width: "100%" }}
        onPress={() => {
          if (!disabled) onPress();
        }}
      />
    </View>
  );
}
