import type { BotAvatarSet } from "@rakazo/contracts";
import { BOT_COLORS } from "@rakazo/contracts";
import {
  botLookState,
  botLookWithColor,
  botLookWithShape,
  SHIPPED_BOT_AVATAR_SHAPE_KEYS,
} from "@rakazo/core";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { BotAvatar } from "./bot-avatar";

/**
 * The shape grid and color row for a bot's look, as on web. With `organicIdentities`, the grid
 * offers the organic body each identity draws (for a bot that has no id yet); without them,
 * "Default" restores the bot's own organic body.
 */
export function BotLookPicker({
  value,
  identity,
  organicIdentities,
  avatarSet,
  onChange,
}: {
  value: string;
  identity?: string;
  organicIdentities?: readonly string[];
  avatarSet: BotAvatarSet;
  onChange: (value: string, identity?: string) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { photo, shapeIndex: shape, color, defaultLook } = botLookState(value);
  const labeled = !organicIdentities;

  return (
    <View style={{ gap: 20 }}>
      {avatarSet === "organic" ? (
        <View>
          {labeled ? <Label>{t("Shape")}</Label> : null}
          <View accessibilityRole="radiogroup" style={grid}>
            {organicIdentities ? (
              organicIdentities.map((organic, index) => (
                <Choice
                  key={organic}
                  label={t("Shape {number}", { number: index + 1 })}
                  selected={defaultLook && identity === organic}
                  onPress={() => onChange(color, organic)}
                >
                  <BotAvatar color={color} identity={organic} size={40} />
                </Choice>
              ))
            ) : (
              <Choice label={t("Default")} selected={defaultLook} onPress={() => onChange(color)}>
                <BotAvatar color={color} identity={identity} size={40} />
              </Choice>
            )}
            {SHIPPED_BOT_AVATAR_SHAPE_KEYS.map((key, index) => (
              <Choice
                key={key}
                label={t("Shape {number}", {
                  number: index + 1 + (organicIdentities?.length ?? 0),
                })}
                selected={shape === index}
                onPress={() => onChange(botLookWithShape(color, index))}
              >
                <BotAvatar color={botLookWithShape(color, index)} identity={identity} size={40} />
              </Choice>
            ))}
          </View>
        </View>
      ) : null}
      <View>
        {labeled ? <Label>{t("Color")}</Label> : null}
        <View accessibilityRole="radiogroup" style={grid}>
          {BOT_COLORS.map((option, index) => {
            const selected = !photo && color.toLowerCase() === option.toLowerCase();
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityLabel={t("Color {number}", { number: index + 1 })}
                accessibilityState={{ checked: selected }}
                onPress={() => onChange(botLookWithColor(value, option))}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  padding: 3,
                  borderWidth: 2,
                  borderColor: selected ? tokens.foreground : "transparent",
                }}
              >
                <View
                  style={{
                    flex: 1,
                    borderRadius: 20,
                    backgroundColor: option,
                    borderWidth: 1,
                    borderColor: tokens.border,
                  }}
                />
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const grid = {
  flexDirection: "row",
  flexWrap: "wrap",
  justifyContent: "center",
  gap: 10,
} as const;

function Label({ children }: { children: string }) {
  const tokens = useMobileTokens();
  return (
    <Text style={{ color: tokens.mutedForeground, fontSize: 14, marginBottom: 8 }}>{children}</Text>
  );
}

function Choice({
  label,
  selected,
  onPress,
  children,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const tokens = useMobileTokens();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={{
        padding: 4,
        borderRadius: 14,
        borderWidth: 2,
        borderColor: selected ? tokens.foreground : "transparent",
      }}
    >
      {children}
    </Pressable>
  );
}
