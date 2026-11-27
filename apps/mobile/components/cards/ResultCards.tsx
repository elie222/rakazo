import {
  markRemoteImageLoaded,
  RemoteImagesContext,
  remoteImageRenders,
  safeExternalHttpUrl,
} from "@rakazo/chat-ui/native";
import type { MessageBlock } from "@rakazo/contracts";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { useContext, useState } from "react";
import { Image, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";

type ResultCardsBlock = Extract<MessageBlock, { kind: "result_cards" }>;
type StatusCardBlock = Extract<MessageBlock, { kind: "card" }>;

export function StatusCard({ block }: { block: StatusCardBlock }) {
  const tokens = mobileTokens();
  return (
    <View
      style={{
        borderRadius: 16,
        backgroundColor: tokens.muted,
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 6,
      }}
    >
      {block.lines.map((line) => (
        <View key={line.k} style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}>
          <Text style={{ color: tokens.foreground, fontWeight: fontWeight.semibold }}>
            {line.k}
          </Text>
          <Text style={{ color: tokens.mutedForeground }}>→</Text>
          <Text style={{ color: tokens.foreground, flexShrink: 1 }}>{line.v}</Text>
        </View>
      ))}
    </View>
  );
}

export function ResultCards({ block }: { block: ResultCardsBlock }) {
  const tokens = mobileTokens();
  const loadRemote = useContext(RemoteImagesContext);
  const [, setRevision] = useState(0);
  return (
    <View style={{ width: "100%", gap: 8 }}>
      {block.title ? (
        <Text
          style={{
            fontSize: typeScale.secondary.fontSize,
            lineHeight: typeScale.secondary.lineHeight,
            fontWeight: fontWeight.medium,
            color: tokens.mutedForeground,
          }}
        >
          {block.title}
        </Text>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 10, paddingVertical: 2 }}
      >
        {block.items.map((item, index) => {
          const href = safeExternalHttpUrl(item.url);
          const imageSrc = safeExternalHttpUrl(item.imageUrl);
          return (
            <Pressable
              key={`${item.title}-${index}`}
              disabled={!href}
              onPress={() => {
                if (href) void Linking.openURL(href);
              }}
              style={{
                width: 224,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: tokens.border,
                backgroundColor: tokens.card,
                overflow: "hidden",
              }}
            >
              {imageSrc ? (
                remoteImageRenders(imageSrc, loadRemote, false) ? (
                  <Image
                    source={{ uri: imageSrc }}
                    style={{ width: "100%", height: 120, backgroundColor: tokens.muted }}
                    resizeMode="cover"
                  />
                ) : (
                  <Pressable
                    onPress={() => {
                      markRemoteImageLoaded(imageSrc);
                      setRevision((n) => n + 1);
                    }}
                    style={{
                      width: "100%",
                      height: 84,
                      backgroundColor: tokens.muted,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text
                      style={{
                        fontSize: typeScale.caption.fontSize,
                        color: tokens.mutedForeground,
                        fontWeight: fontWeight.medium,
                      }}
                    >
                      Load image
                    </Text>
                  </Pressable>
                )
              ) : null}
              <View style={{ padding: 12, gap: 4 }}>
                <Text
                  numberOfLines={2}
                  style={{
                    fontSize: typeScale.body.fontSize,
                    lineHeight: typeScale.body.lineHeight,
                    fontWeight: fontWeight.semibold,
                    color: tokens.foreground,
                  }}
                >
                  {item.title}
                </Text>
                {item.subtitle ? (
                  <Text
                    numberOfLines={2}
                    style={{
                      fontSize: typeScale.secondary.fontSize,
                      lineHeight: typeScale.secondary.lineHeight,
                      color: tokens.mutedForeground,
                    }}
                  >
                    {item.subtitle}
                  </Text>
                ) : null}
                {item.price || item.rating ? (
                  <View style={{ flexDirection: "row", gap: 8, paddingTop: 2 }}>
                    {item.price ? (
                      <Text
                        style={{
                          fontSize: typeScale.secondary.fontSize,
                          fontWeight: fontWeight.semibold,
                          color: tokens.foreground,
                        }}
                      >
                        {item.price}
                      </Text>
                    ) : null}
                    {item.rating ? (
                      <Text
                        style={{
                          fontSize: typeScale.secondary.fontSize,
                          color: tokens.mutedForeground,
                        }}
                      >
                        {item.rating}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
                {item.badges && item.badges.length > 0 ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, paddingTop: 2 }}>
                    {item.badges.map((badge) => (
                      <View
                        key={badge}
                        style={{
                          borderRadius: 6,
                          backgroundColor: tokens.muted,
                          paddingHorizontal: 6,
                          paddingVertical: 2,
                        }}
                      >
                        <Text
                          style={{
                            fontSize: typeScale.caption.fontSize,
                            color: tokens.mutedForeground,
                          }}
                        >
                          {badge}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                {item.meta ? (
                  <Text
                    numberOfLines={1}
                    style={{
                      fontSize: typeScale.caption.fontSize,
                      color: tokens.mutedForeground,
                    }}
                  >
                    {item.meta}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
