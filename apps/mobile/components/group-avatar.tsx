import { memo } from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import { BotAvatar } from "./bot-avatar";

export interface GroupAvatarMember {
  botId?: string;
  name?: string;
  color: string;
  status?: string;
}

export const GroupAvatar = memo(function GroupAvatar({
  members,
  size = 54,
}: {
  members: GroupAvatarMember[];
  size?: number;
}) {
  const firstMember = members[0];
  if (!firstMember) {
    return (
      <View
        style={[
          styles.fallback,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
          },
        ]}
      >
        <Text style={[styles.fallbackText, { fontSize: Math.round(size * 0.35) }]}>👥</Text>
      </View>
    );
  }

  if (members.length === 1) {
    return (
      <BotAvatar
        color={firstMember.color}
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
            borderRadius: miniSize / 2,
            borderWidth: 1.5,
            borderColor: "#121215",
          }}
        >
          <BotAvatar
            color={member.color}
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
            backgroundColor: "#202026",
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1.5,
            borderColor: "#121215",
          }}
        >
          <Text style={{ color: "#E0E0E6", fontSize: 10, fontWeight: "600" }}>
            +{members.length - 2}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: "#202024",
    alignItems: "center",
    justifyContent: "center",
  },
  fallbackText: {
    color: "#9A9AA2",
  },
});
