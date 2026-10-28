import type { BotAvatarSet } from "@rakazo/contracts";
import { memo } from "react";
import type { ViewStyle } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import { native, useThemedStyles } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { NativeSymbol } from "./native-symbol";

export interface GroupAvatarMember {
  botId?: string;
  name?: string;
  color: string;
  avatarSet?: BotAvatarSet;
  status?: string;
}

export const GroupAvatar = memo(function GroupAvatar({
  members,
  size = 54,
}: {
  members: GroupAvatarMember[];
  size?: number;
}) {
  const styles = useThemedStyles(createGroupAvatarStyles);
  const firstMember = members[0];
  if (!firstMember) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.fallback,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
          },
        ]}
      >
        <NativeSymbol
          ios="person.2.fill"
          android="people"
          size={Math.round(size * 0.45)}
          color={native.secondaryLabel}
        />
      </View>
    );
  }

  if (members.length === 1) {
    return (
      <BotAvatar
        color={firstMember.color}
        avatarSet={firstMember.avatarSet}
        identity={firstMember.botId ?? firstMember.name}
        size={size}
        status={firstMember.status}
      />
    );
  }

  const pair = members.length === 2;
  const miniSize = Math.round(size * (pair ? 0.65 : 0.54));
  const positions: ViewStyle[] = pair
    ? [
        { top: 0, left: 0 },
        { right: 0, bottom: 0 },
      ]
    : [
        { top: 0, left: (size - miniSize) / 2 },
        { bottom: 0, left: 0 },
        { right: 0, bottom: 0 },
      ];
  const visibleMembers = members.slice(0, pair || members.length === 3 ? members.length : 2);

  return (
    <View style={{ width: size, height: size, position: "relative" }}>
      {visibleMembers.map((member, index) => (
        <View
          key={member.botId ?? index}
          style={{
            position: "absolute",
            ...positions[index],
            zIndex: index + 1,
          }}
        >
          <BotAvatar
            color={member.color}
            avatarSet={member.avatarSet}
            identity={member.botId ?? member.name}
            size={miniSize}
            status={member.status}
          />
        </View>
      ))}
      {members.length > 3 ? (
        <View
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            zIndex: 3,
            width: miniSize,
            height: miniSize,
            borderRadius: miniSize / 2,
            backgroundColor: native.fillPressed,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: native.label, fontSize: 10, fontWeight: "600" }}>
            +{members.length - 2}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

function createGroupAvatarStyles() {
  return StyleSheet.create({
    fallback: {
      backgroundColor: native.fillPressed,
      alignItems: "center",
      justifyContent: "center",
    },
  });
}
