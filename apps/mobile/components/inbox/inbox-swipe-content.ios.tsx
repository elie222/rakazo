import { Button, Circle, Host, Image, ZStack } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  contentShape,
  font,
  foregroundStyle,
  frame,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useContext, useEffect, useId, useState } from "react";
import type { ColorValue } from "react-native";
import { I18nManager, PlatformColor, Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import type { InboxRowAction, inboxRowActions } from "../../lib/inbox/inbox-swipe";
import { INBOX_ROW_ACTIONS } from "../../lib/inbox/inbox-swipe";
import { hapticSelection } from "../../lib/native/haptics";
import { useMobileTokens } from "../../lib/native/native";
import { InboxSwipeContext } from "./inbox-swipe-context";

const ACTION_DIAMETER = 50;
const ACTION_SPACING = 10;
const ACTION_INSET = 10;
const ACTION_STEP = ACTION_DIAMETER + ACTION_SPACING;
const LEADING_WIDTH = ACTION_DIAMETER + 2 * ACTION_INSET;
const ACTION_REVEAL_START = 20;
const ACTION_FADE_DISTANCE = 4;
const OPEN_DISTANCE = 24;
const MAX_OVERSHOOT = 24;
const DIRECTION = I18nManager.isRTL ? -1 : 1;
const READ_FILL = PlatformColor("systemBlue");
const ARCHIVE_FILL = PlatformColor("systemRed");
const PIN_FILL = PlatformColor("systemGray3");
const ACTION_INK = PlatformColor("whiteColor");

/** Move the row with the gesture and grow its actions as space opens up. */
export function InboxSwipeContent({
  actions,
  children,
  onAction,
}: {
  actions: ReturnType<typeof inboxRowActions>;
  children: ReactNode;
  onAction: (action: InboxRowAction) => void;
}) {
  const { i18n } = useLingui();
  const tokens = useMobileTokens();
  const activeSwipe = useContext(InboxSwipeContext);
  const id = useId();
  const width = useSharedValue(0);
  const offset = useSharedValue(0);
  const resting = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const dragging = useSharedValue(false);
  const armed = useSharedValue(false);
  const [showActions, setShowActions] = useState(false);
  const [open, setOpen] = useState(false);
  const trailingWidth = LEADING_WIDTH + (actions.trailing.length - 1) * ACTION_STEP;
  const { leading } = actions;

  useEffect(
    () => () => {
      if (activeSwipe?.current?.id === id) activeSwipe.current = null;
    },
    [activeSwipe, id],
  );

  function settleOffset(target: number) {
    "worklet";
    offset.value = withTiming(target, undefined, (finished) => {
      if (finished && target === 0) scheduleOnRN(setShowActions, false);
    });
  }

  function close() {
    scheduleOnUI(() => {
      "worklet";
      dragging.value = false;
      armed.value = false;
      resting.value = 0;
      settleOffset(0);
    });
    setOpen(false);
    if (activeSwipe?.current?.id === id) activeSwipe.current = null;
  }

  function closeOtherSwipe() {
    if (activeSwipe?.current?.id !== id) activeSwipe?.current?.close();
  }

  function begin() {
    setShowActions(true);
    closeOtherSwipe();
    if (activeSwipe) activeSwipe.current = { id, close };
  }

  function activate(action: InboxRowAction) {
    close();
    onAction(action);
  }

  const pan = Gesture.Pan()
    // Let vertical drags go to the native list and hold the row still until intent is clear.
    .activeOffsetX([-10, 10])
    .failOffsetY([-8, 8])
    .maxPointers(1)
    .onBegin(() => {
      scheduleOnRN(closeOtherSwipe);
    })
    .onStart(() => {
      cancelAnimation(offset);
      dragStart.value = offset.value;
      dragging.value = true;
      armed.value = false;
      scheduleOnRN(begin);
    })
    .onUpdate(({ translationX }) => {
      if (!dragging.value) return;
      const distance = dragStart.value + translationX * DIRECTION;
      const rail = distance > 0 ? LEADING_WIDTH : trailingWidth;
      const fullSwipe =
        resting.value === 0 &&
        width.value > 0 &&
        Math.abs(distance) >= Math.max(width.value * 0.55, rail + OPEN_DISTANCE);
      if (fullSwipe && !armed.value) scheduleOnRN(hapticSelection);
      armed.value = fullSwipe;
      const travel = Math.abs(distance);
      const extra = Math.max(0, travel - rail);
      const overshoot = (MAX_OVERSHOOT * extra) / (extra + MAX_OVERSHOOT * 4);
      offset.value = Math.sign(distance) * (Math.min(travel, rail) + overshoot);
    })
    .onEnd(({ translationX }, success) => {
      if (!dragging.value) return;
      dragging.value = false;
      if (!success) {
        armed.value = false;
        settleOffset(resting.value);
        return;
      }
      const distance = offset.value;
      if (armed.value) {
        scheduleOnRN(activate, distance > 0 ? leading : actions.trailing[0]);
        return;
      }
      const towardCenter = Math.sign(resting.value) * translationX * DIRECTION < -OPEN_DISTANCE;
      let target = 0;
      if (distance > OPEN_DISTANCE && !(resting.value > 0 && towardCenter)) target = LEADING_WIDTH;
      if (distance < -OPEN_DISTANCE && !(resting.value < 0 && towardCenter))
        target = -trailingWidth;
      resting.value = target;
      settleOffset(target);
      scheduleOnRN(setOpen, target !== 0);
    });
  const foreground = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value * DIRECTION }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <View
        style={styles.clip}
        onLayout={(event) => {
          width.value = event.nativeEvent.layout.width;
        }}
      >
        {/* The row exposes the same actions to VoiceOver. */}
        {showActions ? (
          <View
            style={StyleSheet.absoluteFill}
            pointerEvents="box-none"
            accessibilityElementsHidden
          >
            <SwipeActionButton
              action={leading}
              label={i18n._(INBOX_ROW_ACTIONS[leading].label)}
              fill={READ_FILL}
              offset={offset}
              armed={armed}
              edge="start"
              index={0}
              onPress={() => activate(leading)}
            />
            {actions.trailing.map((action, index) => (
              <SwipeActionButton
                key={action}
                action={action}
                label={i18n._(INBOX_ROW_ACTIONS[action].label)}
                fill={action === "archive" ? ARCHIVE_FILL : PIN_FILL}
                offset={offset}
                armed={armed}
                edge="end"
                index={index}
                onPress={() => activate(action)}
              />
            ))}
          </View>
        ) : null}
        <Animated.View style={[{ backgroundColor: tokens.background }, foreground]}>
          {children}
          {open ? (
            <Pressable
              style={StyleSheet.absoluteFill}
              accessible={false}
              accessibilityElementsHidden
              onPress={close}
            />
          ) : null}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

function SwipeActionButton({
  action,
  label,
  fill,
  offset,
  armed,
  edge,
  index,
  onPress,
}: {
  action: InboxRowAction;
  label: string;
  fill: ColorValue;
  offset: SharedValue<number>;
  armed: SharedValue<boolean>;
  edge: "start" | "end";
  index: number;
  onPress: () => void;
}) {
  const { systemImage } = INBOX_ROW_ACTIONS[action];
  const icon =
    systemImage === "eye.slash" || systemImage === "pin" || systemImage === "pin.slash"
      ? (`${systemImage}.fill` as const)
      : systemImage;
  const direction = edge === "start" ? 1 : -1;
  const position = index * ACTION_STEP;
  const restingCenter = ACTION_INSET + ACTION_DIAMETER / 2;
  const revealStyle = useAnimatedStyle(() => {
    // Start each circle inside the uncovered space, then grow it to the resting size.
    const exposed = Math.max(0, direction * offset.value - position);
    const reveal = Math.max(0, exposed - ACTION_REVEAL_START);
    const progress = Math.min(1, reveal / (LEADING_WIDTH - ACTION_REVEAL_START));
    const center = Math.min(restingCenter, exposed / 2);
    const commitsOnRelease = armed.value && exposed > 0;
    return {
      opacity: commitsOnRelease && index > 0 ? 0.3 : Math.min(1, reveal / ACTION_FADE_DISTANCE),
      transform: [
        { translateX: (center - restingCenter) * direction * DIRECTION },
        { scale: commitsOnRelease && index === 0 ? 1.2 : 0.26 + 0.74 * progress },
      ],
    };
  });

  return (
    <View pointerEvents="box-none" style={[styles.actionSlot, { [edge]: position + ACTION_INSET }]}>
      <Animated.View style={[styles.action, revealStyle]}>
        <Host style={StyleSheet.absoluteFill} ignoreSafeArea="all">
          <Button onPress={onPress} modifiers={[buttonStyle("plain"), accessibilityLabel(label)]}>
            <ZStack
              modifiers={[
                frame({ width: ACTION_DIAMETER, height: ACTION_DIAMETER }),
                contentShape(shapes.circle()),
              ]}
            >
              <Circle modifiers={[foregroundStyle(fill)]} />
              <Image
                systemName={icon}
                modifiers={[font({ size: 24, weight: "semibold" }), foregroundStyle(ACTION_INK)]}
              />
            </ZStack>
          </Button>
        </Host>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  actionSlot: { position: "absolute", top: 0, bottom: 0, justifyContent: "center" },
  action: { width: ACTION_DIAMETER, height: ACTION_DIAMETER },
});
