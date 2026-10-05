import { useEffect, useState } from "react";
import { Alert, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import type { MobileArtifactTarget } from "../lib/artifact-open";
import { imageArtifactUri, shareLocalFile } from "../lib/artifact-open";
import { useI18n } from "../lib/i18n";
import type { ImageSize } from "../lib/inline-image";
import { fitImageSize } from "../lib/inline-image";
import { NativeSymbol } from "./native-symbol";

export type ImageArtifactPreviewTarget = {
  artifactId: string;
  name: string;
  mimeType: string;
};

const HEADER_HEIGHT = 54;
const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

/**
 * The image at its contained size inside `box`. Pinch to zoom, drag to pan while zoomed with the
 * pan clamped to what is actually displayed, double-tap to toggle, single tap at 1x to close.
 */
function ZoomableImage({
  uri,
  displayed,
  box,
  onClose,
  onError,
}: {
  uri: string;
  displayed: ImageSize;
  box: ImageSize;
  onClose: () => void;
  onError: () => void;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  // A rotation changes the box and the displayed size; a pan that fit before may now sit
  // outside the viewport, so start again from 1x.
  useEffect(() => {
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedX.value = 0;
    savedY.value = 0;
  }, [box.width, box.height, scale, savedScale, translateX, translateY, savedX, savedY]);

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale.value * event.scale));
      scale.value = next;
      // Keep the current pan inside the bounds of the new scale, so shrinking never strands
      // the image off-screen.
      const maxX = Math.max(0, (displayed.width * next - box.width) / 2);
      const maxY = Math.max(0, (displayed.height * next - box.height) / 2);
      translateX.value = Math.min(maxX, Math.max(-maxX, translateX.value));
      translateY.value = Math.min(maxY, Math.max(-maxY, translateY.value));
    })
    .onEnd(() => {
      if (scale.value <= 1.02) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedX.value = 0;
        savedY.value = 0;
        return;
      }
      savedScale.value = scale.value;
      savedX.value = translateX.value;
      savedY.value = translateY.value;
    });
  const pan = Gesture.Pan()
    .maxPointers(2)
    .onUpdate((event) => {
      if (savedScale.value <= 1) return;
      const maxX = Math.max(0, (displayed.width * scale.value - box.width) / 2);
      const maxY = Math.max(0, (displayed.height * scale.value - box.height) / 2);
      translateX.value = Math.min(maxX, Math.max(-maxX, savedX.value + event.translationX));
      translateY.value = Math.min(maxY, Math.max(-maxY, savedY.value + event.translationY));
    })
    .onEnd(() => {
      savedX.value = translateX.value;
      savedY.value = translateY.value;
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = savedScale.value > 1 ? 1 : DOUBLE_TAP_SCALE;
      scale.value = withTiming(next);
      savedScale.value = next;
      translateX.value = withTiming(0);
      translateY.value = withTiming(0);
      savedX.value = 0;
      savedY.value = 0;
    });
  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .runOnJS(true)
    .onEnd(() => {
      if (savedScale.value <= 1) onClose();
    });
  const gesture = Gesture.Race(
    Gesture.Exclusive(doubleTap, singleTap),
    Gesture.Simultaneous(pinch, pan),
  );
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.Image
        source={{ uri }}
        resizeMode="contain"
        style={[{ width: displayed.width, height: displayed.height }, animatedStyle]}
        onError={onError}
        accessibilityIgnoresInvertColors
      />
    </GestureDetector>
  );
}

/**
 * Full-screen image viewer: zoom, share or export through the system sheet, close. Rendered as
 * its own stack screen (see app/image.tsx) rather than a React Native Modal: presenting the share
 * sheet over a full-screen Modal and cancelling it leaves that Modal black on iOS.
 */
export function ImageArtifactViewer({
  threadTarget,
  target,
  onClose,
}: {
  threadTarget: MobileArtifactTarget;
  target: ImageArtifactPreviewTarget;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const insets = useSafeAreaInsets();
  const [box, setBox] = useState<ImageSize | null>(null);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; uri: string; natural: ImageSize }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const targetBotId = "botId" in threadTarget ? threadTarget.botId : undefined;
  const targetGroupId = "groupId" in threadTarget ? threadTarget.groupId : undefined;
  const requestTarget = (): MobileArtifactTarget =>
    targetBotId !== undefined ? { botId: targetBotId } : { groupId: targetGroupId! };
  const fail = (error: unknown) =>
    setState({
      status: "error",
      message: error instanceof Error ? error.message : t("Could not load image"),
    });

  useEffect(() => {
    let cancelled = false;
    void imageArtifactUri(requestTarget(), target.artifactId, target.mimeType)
      .then(
        (uri) =>
          new Promise<{ uri: string; natural: ImageSize }>((resolve, reject) => {
            Image.getSize(
              uri,
              (width, height) => resolve({ uri, natural: { width, height } }),
              reject,
            );
          }),
      )
      .then((loaded) => {
        if (!cancelled) setState({ status: "ready", ...loaded });
      })
      .catch((error) => {
        if (!cancelled) fail(error);
      });
    return () => {
      cancelled = true;
    };
    // The request target is derived from the two ids below.
  }, [targetBotId, targetGroupId, target.artifactId, target.mimeType]);

  // Re-resolve the file before sharing: it re-downloads when the OS purged the cache since load.
  const share = () =>
    void imageArtifactUri(requestTarget(), target.artifactId, target.mimeType)
      .then((uri) => shareLocalFile(uri, target.mimeType, target.name))
      .catch((error) =>
        Alert.alert(
          t("Could not share image"),
          error instanceof Error ? error.message : t("Try again."),
        ),
      );

  return (
    // Insets come from the SafeAreaProvider mounted by app/image.tsx, seeded with the window
    // metrics so they are right on the first frame.
    <View
      style={[
        styles.screen,
        {
          backgroundColor: tokens.background,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      <View style={[styles.header, { borderBottomColor: tokens.border }]}>
        <Text numberOfLines={1} style={[styles.title, { color: tokens.foreground }]}>
          {target.name}
        </Text>
        <Pressable
          accessibilityLabel={t("Share {name}", { name: target.name })}
          hitSlop={8}
          onPress={share}
          style={styles.headerButton}
        >
          <NativeSymbol
            ios="square.and.arrow.up"
            android="share-social-outline"
            size={20}
            color={tokens.mutedForeground}
          />
        </Pressable>
        <Pressable
          accessibilityLabel={t("Close image")}
          hitSlop={8}
          onPress={onClose}
          style={styles.headerButton}
        >
          <NativeSymbol ios="xmark" android="close" size={20} color={tokens.mutedForeground} />
        </Pressable>
      </View>
      <View
        style={styles.stage}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          if (width <= 0 || height <= 0) return;
          setBox((current) =>
            current?.width === width && current?.height === height ? current : { width, height },
          );
        }}
      >
        {state.status === "ready" && box ? (
          <ZoomableImage
            uri={state.uri}
            displayed={fitImageSize(state.natural, box.width, box.height)}
            box={box}
            onClose={onClose}
            onError={() => fail(new Error(t("Could not load image")))}
          />
        ) : (
          <Text style={[styles.message, { color: tokens.mutedForeground }]}>
            {state.status === "error" ? state.message : t("Loading image…")}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    height: HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  title: { flex: 1, fontSize: 15, fontWeight: "500" },
  headerButton: { padding: 10 },
  stage: { flex: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  message: { fontSize: 15, textAlign: "center", padding: 24 },
});
