import { useEffect, useState } from "react";

/**
 * At most this many working avatars loop at once. With many bots busy, the rest hold still
 * until a slot frees up, so a busy roster never costs more than a few animated layers.
 */
export const MAX_WORKING_MOTION = 6;

type Claim = { grant: (granted: boolean) => void; granted: boolean };
const claims: Claim[] = [];

function settle() {
  claims.forEach((claim, index) => {
    const granted = index < MAX_WORKING_MOTION;
    if (claim.granted !== granted) {
      claim.granted = granted;
      claim.grant(granted);
    }
  });
}

/**
 * Asks for one of the shared working-motion slots while `wanted`. Slots go first come, first
 * served; a `priority` claim (the status row under the thread) goes ahead of the roster.
 */
export function useMotionSlot(wanted: boolean, priority = false) {
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    const claim: Claim = { grant: setGranted, granted: false };
    if (priority) claims.unshift(claim);
    else claims.push(claim);
    settle();
    return () => {
      claims.splice(claims.indexOf(claim), 1);
      setGranted(false);
      settle();
    };
  }, [wanted, priority]);
  return wanted && granted;
}

/** For tests: how many slots are claimed. */
export function claimedMotionSlots() {
  return claims.length;
}
