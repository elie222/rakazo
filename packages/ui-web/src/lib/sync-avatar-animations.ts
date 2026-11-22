import { avatarSharedTimeMs } from "@rakazo/core";

/**
 * Sets every looping CSS animation under `element` to the shared avatar clock, so every
 * copy of a bot's avatar is at the same point in its motion however long it has been on
 * screen. A running loop is started at that point. A paused one only moves there: setting
 * a start time would override its `animation-play-state` for good. `offsetMs` shifts one
 * bot's motion so different bots do not move in unison. Returns every animation it looked
 * at, so a caller need not ask the browser for them again.
 */
export function syncAvatarAnimations(element: Element, offsetMs = 0): Animation[] {
  // The timeline reads the time a frame started, which lags by a different amount at each
  // call; the clock it counts from does not, so read both clocks at the same instant.
  const timeline = performance.now();
  const shared = avatarSharedTimeMs() + offsetMs;
  const animations = element.getAnimations?.({ subtree: true }) ?? [];
  for (const animation of animations) {
    if (animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY) continue;
    if (animation.playState === "running") animation.startTime = timeline - shared;
    else animation.currentTime = shared;
  }
  return animations;
}
