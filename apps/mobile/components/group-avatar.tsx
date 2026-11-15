import type { BotAvatarSet } from "@rakazo/contracts";
import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { groupAvatarTiles } from "../lib/group-seats";
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

  const tiles = groupAvatarTiles(members, size);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      {tiles.map((tile, index) => (
        <View
          key={tile.kind === "member" ? (tile.member.botId ?? index) : "more"}
          style={{
            position: "absolute",
            left: tile.left,
            top: tile.top,
            // The first tile sits above the rest.
            zIndex: tiles.length - index,
          }}
        >
          {tile.kind === "member" ? (
            <BotAvatar
              color={tile.member.color}
              avatarSet={tile.member.avatarSet}
              identity={tile.member.botId ?? tile.member.name}
              size={tile.size}
              status={tile.member.status}
            />
          ) : (
            // A chip ringed in the page colour, so it reads apart from the faces it touches.
            <View
              style={[
                styles.more,
                { width: tile.size, height: tile.size, borderRadius: tile.size / 2 },
              ]}
            >
              <Text
                allowFontScaling={false}
                style={[styles.moreText, { fontSize: Math.round(tile.size * 0.42) }]}
              >
                +{tile.count}
              </Text>
            </View>
          )}
        </View>
      ))}
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
    more: {
      backgroundColor: native.fillPressed,
      borderWidth: 2,
      borderColor: native.page,
      alignItems: "center",
      justifyContent: "center",
    },
    moreText: { color: native.label, fontWeight: "500" },
  });
}
