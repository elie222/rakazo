import { StyleSheet, Text, View } from "react-native";
import { BotAvatar } from "./bot-avatar";

export interface GroupAvatarMember {
  botId?: string;
  name?: string;
  color: string;
  status?: string;
}

export function GroupAvatar({
  members,
  size = 54,
}: {
  members: GroupAvatarMember[];
  size?: number;
}) {
  if (!members || members.length === 0) {
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
        color={members[0]!.color}
        size={size}
        status={members[0]!.status}
      />
    );
  }

  if (members.length === 2) {
    const miniSize = Math.round(size * 0.65);
    return (
      <View style={{ width: size, height: size, position: "relative" }}>
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            zIndex: 1,
            borderRadius: miniSize / 2,
            borderWidth: 1.5,
            borderColor: "#121215",
          }}
        >
          <BotAvatar
            color={members[0]!.color}
            size={miniSize}
            status={members[0]!.status}
          />
        </View>
        <View
          style={{
            position: "absolute",
            bottom: 0,
            right: 0,
            zIndex: 2,
            borderRadius: miniSize / 2,
            borderWidth: 1.5,
            borderColor: "#121215",
          }}
        >
          <BotAvatar
            color={members[1]!.color}
            size={miniSize}
            status={members[1]!.status}
          />
        </View>
      </View>
    );
  }

  const miniSize = Math.round(size * 0.54);
  const extraCount = members.length - 2;

  return (
    <View style={{ width: size, height: size, position: "relative" }}>
      <View
        style={{
          position: "absolute",
          top: 0,
          left: (size - miniSize) / 2,
          zIndex: 1,
          borderRadius: miniSize / 2,
          borderWidth: 1.5,
          borderColor: "#121215",
        }}
      >
        <BotAvatar
          color={members[0]!.color}
          size={miniSize}
          status={members[0]!.status}
        />
      </View>
      <View
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          zIndex: 2,
          borderRadius: miniSize / 2,
          borderWidth: 1.5,
          borderColor: "#121215",
        }}
      >
        <BotAvatar
          color={members[1]!.color}
          size={miniSize}
          status={members[1]!.status}
        />
      </View>
      {members.length === 3 ? (
        <View
          style={{
            position: "absolute",
            bottom: 0,
            right: 0,
            zIndex: 3,
            borderRadius: miniSize / 2,
            borderWidth: 1.5,
            borderColor: "#121215",
          }}
        >
          <BotAvatar
            color={members[2]!.color}
            size={miniSize}
            status={members[2]!.status}
          />
        </View>
      ) : (
        <View
          style={{
            position: "absolute",
            bottom: 0,
            right: 0,
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
            +{extraCount}
          </Text>
        </View>
      )}
    </View>
  );
}

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
