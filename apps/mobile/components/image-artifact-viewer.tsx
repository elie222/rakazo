import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { mobileTokens } from "../lib/appearance";
import type { MobileArtifactTarget } from "../lib/artifact-open";
import { imageArtifactPreview, imageArtifactUri, shareLocalFile } from "../lib/artifact-open";
import { useI18n } from "../lib/i18n";
import { imageDismissBackdropOpacity, shouldDismissImage } from "../lib/image-dismiss";
import type { ImageSize } from "../lib/inline-image";
import { fitImageSize } from "../lib/inline-image";
import { iosAtLeast } from "../lib/native-controls";
import { errorText } from "../lib/user-error";
import { GlassIconButton } from "./glass-icon-button";

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
 * pan clamped to what is actually displayed, double-tap to toggle, drag or single tap at 1x to close.
 */
function ZoomableImage({
  uri,
  displayed,
  box,
  onClose,
  onError,
  dismissY,
}: {
  uri: string;
  displayed: ImageSize;
  box: ImageSize;
  onClose: () => void;
  onError: () => void;
  dismissY: SharedValue<number>;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const dismissible = useSharedValue(false);
  const closing = useSharedValue(false);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  const restoreBackdrop = () => {
    "worklet";
    dismissY.value = withSpring(0, { damping: 20, stiffness: 200 });
  };
  const resetToRest = () => {
    "worklet";
    scale.value = withTiming(1);
    savedScale.value = 1;
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedX.value = 0;
    savedY.value = 0;
    restoreBackdrop();
  };
  const close = () => {
    "worklet";
    if (closing.value) return;
    closing.value = true;
    scheduleOnRN(onClose);
  };
  const clampPan = (x: number, y: number) => {
    "worklet";
    const maxX = Math.max(0, (displayed.width * scale.value - box.width) / 2);
    const maxY = Math.max(0, (displayed.height * scale.value - box.height) / 2);
    translateX.value = Math.min(maxX, Math.max(-maxX, x));
    translateY.value = Math.min(maxY, Math.max(-maxY, y));
  };

  // A rotation changes the box and the displayed size; a pan that fit before may now sit
  // outside the viewport, so start again from 1x.
  useEffect(() => {
    dismissible.value = false;
    resetToRest();
  }, [box.width, box.height]);

  const pinch = Gesture.Pinch()
    .onStart(() => {
      dismissible.value = false;
      dismissY.value = 0;
    })
    .onUpdate((event) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale.value * event.scale));
      scale.value = next;
      // Keep the current pan inside the bounds of the new scale, so shrinking never strands
      // the image off-screen.
      clampPan(translateX.value, translateY.value);
    })
    .onEnd(() => {
      if (scale.value <= 1.02) {
        resetToRest();
        return;
      }
      savedScale.value = scale.value;
      savedX.value = translateX.value;
      savedY.value = translateY.value;
    });
  const pan = Gesture.Pan()
    .maxPointers(2)
    .manualActivation(true)
    .onTouchesDown((event, manager) => {
      if (event.numberOfTouches === 1) {
        const touch = event.allTouches[0];
        if (!touch) return;
        startX.value = touch.absoluteX;
        startY.value = touch.absoluteY;
        dismissible.value = savedScale.value === 1 && scale.value <= 1;
        // Leave the native back gesture's edge free, even for diagonal drags.
        if (touch.absoluteX < 24) manager.fail();
      } else {
        dismissible.value = false;
        dismissY.value = 0;
      }
    })
    .onTouchesMove((event, manager) => {
      const touch = event.allTouches[0];
      if (!touch) return;
      const dx = Math.abs(touch.absoluteX - startX.value);
      const dy = Math.abs(touch.absoluteY - startY.value);
      if (savedScale.value > 1) {
        if (Math.max(dx, dy) > 10) manager.activate();
      } else if (dismissible.value) {
        if (dx > 16 && dx > dy) manager.fail();
        else if (dy > 10 && dy > dx) manager.activate();
      }
    })
    .onUpdate((event) => {
      if (dismissible.value && savedScale.value === 1 && scale.value <= 1) {
        dismissY.value = event.translationY;
      } else if (savedScale.value > 1) {
        clampPan(savedX.value + event.translationX, savedY.value + event.translationY);
      }
    })
    .onEnd((event, success) => {
      if (
        success &&
        dismissible.value &&
        savedScale.value === 1 &&
        scale.value <= 1 &&
        shouldDismissImage(event.translationY, event.velocityY)
      ) {
        close();
      }
      savedX.value = translateX.value;
      savedY.value = translateY.value;
    })
    .onFinalize(() => {
      dismissible.value = false;
      if (!closing.value) restoreBackdrop();
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((_event, success) => {
      if (!success) return;
      const next = savedScale.value > 1 ? 1 : DOUBLE_TAP_SCALE;
      resetToRest();
      scale.value = withTiming(next);
      savedScale.value = next;
    });
  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd((_event, success) => {
      if (success && savedScale.value <= 1) close();
    });
  const gesture = Gesture.Race(
    Gesture.Exclusive(doubleTap, singleTap),
    Gesture.Simultaneous(pinch, pan),
  );
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value + dismissY.value },
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
 * a transparent stack screen (see app/image.tsx) so dragging reveals the thread underneath.
 * A React Native Modal instead leaves the viewer black on iOS after cancelling the share sheet.
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
  const dismissY = useSharedValue(0);
  const backdropStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      imageDismissBackdropOpacity(dismissY.value),
      [0, 1],
      ["transparent", tokens.background],
    ),
  }));
  const closed = useRef(false);
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  };
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
      message: errorText(error, t("Could not load image")),
    });

  useEffect(() => {
    let cancelled = false;
    void imageArtifactPreview(requestTarget(), target.artifactId, target.mimeType)
      .then(({ uri, size }) => {
        if (!cancelled) setState({ status: "ready", uri, natural: size });
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
      .catch((error) => Alert.alert(t("Could not share image"), errorText(error, t("Try again."))));

  return (
    // Insets come from the SafeAreaProvider mounted by app/image.tsx, seeded with the window
    // metrics so they are right on the first frame.
    <Animated.View
      style={[
        styles.screen,
        backdropStyle,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      <View
        style={[
          styles.header,
          {
            borderBottomColor: tokens.border,
            borderBottomWidth: iosAtLeast(26) ? 0 : StyleSheet.hairlineWidth,
          },
        ]}
      >
        <Text numberOfLines={1} style={[styles.title, { color: tokens.foreground }]}>
          {target.name}
        </Text>
        <View style={styles.headerActions}>
          <GlassIconButton
            accessibilityLabel={t("Share {name}", { name: target.name })}
            ios="square.and.arrow.up"
            android="share-social-outline"
            iconSize={18}
            onPress={share}
          />
          <GlassIconButton
            accessibilityLabel={t("Close image")}
            ios="xmark"
            android="close"
            iconSize={18}
            onPress={close}
          />
        </View>
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
            onClose={close}
            dismissY={dismissY}
            onError={() => fail(new Error(t("Could not load image")))}
          />
        ) : state.status === "error" ? (
          <Text style={[styles.message, { color: tokens.mutedForeground }]}>{state.message}</Text>
        ) : (
          <ActivityIndicator
            color={tokens.mutedForeground}
            accessibilityLabel={t("Loading image…")}
          />
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    height: HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
  },
  title: { flex: 1, fontSize: 15, fontWeight: "500" },
  headerActions: { flexDirection: "row", gap: 8 },
  stage: { flex: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  message: { fontSize: 15, textAlign: "center", padding: 24 },
});
