import { useTimeout } from "@rakazo/chat-ui/hooks";
import type {
  AvatarClock,
  AvatarLifeState,
  AvatarMotionMode,
  AvatarPoke,
  AvatarSegment,
} from "@rakazo/core";
import {
  AVATAR_POKE_SECONDS,
  AVATAR_POKES,
  AVATAR_SETTLE_MS,
  AVATAR_SHARED_WINDOW_SECONDS,
  avatarClipPool,
  avatarSchedulePose,
  avatarSharedSchedule,
  avatarSharedTimeMs,
} from "@rakazo/core";
import type { ReactNode } from "react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useAppForeground } from "../platform/app-foreground";

const ScreenFocused = createContext(true);

/** Screens behind the visible one stop their avatars; avatars outside a screen count as shown. */
export function AvatarScreenFocus({
  navigation,
  children,
}: {
  navigation: {
    isFocused(): boolean;
    addListener(event: "focus" | "blur", listener: () => void): () => void;
  };
  children: ReactNode;
}) {
  const focused = useSyncExternalStore(
    (listener) => {
      const offFocus = navigation.addListener("focus", listener);
      const offBlur = navigation.addListener("blur", listener);
      return () => {
        offFocus();
        offBlur();
      };
    },
    () => navigation.isFocused(),
  );
  return <ScreenFocused value={focused}>{children}</ScreenFocused>;
}

/** Which list rows are on screen, fed by the list's viewability callback. */
export function createAvatarViewport() {
  let visible = new Set<string>();
  const listeners = new Set<() => void>();
  return {
    update(keys: Iterable<string>) {
      visible = new Set(keys);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    has: (key: string) => visible.has(key),
  };
}
export type AvatarViewport = ReturnType<typeof createAvatarViewport>;

const Viewport = createContext<AvatarViewport | null>(null);
const RowKey = createContext<string | null>(null);

/** Lets the rows of one list know whether they are on screen. */
export function AvatarViewportScope({
  viewport,
  children,
}: {
  viewport: AvatarViewport;
  children: ReactNode;
}) {
  return <Viewport value={viewport}>{children}</Viewport>;
}

/** Marks the avatars inside as belonging to the list row `id`. */
export function AvatarRow({ id, children }: { id: string; children: ReactNode }) {
  return <RowKey value={id}>{children}</RowKey>;
}

const noViewport = () => () => undefined;

/**
 * Whether an avatar is on the visible screen of a foreground app and, inside a list,
 * in a row that is scrolled into view. Rows scrolled away freeze until they return.
 */
export function useAvatarOnScreen(): boolean {
  const foreground = useAppForeground();
  const focused = useContext(ScreenFocused);
  const viewport = useContext(Viewport);
  const row = useContext(RowKey);
  const rowVisible = useSyncExternalStore(viewport?.subscribe ?? noViewport, () =>
    viewport && row !== null ? viewport.has(row) : true,
  );
  return focused && foreground && rowVisible;
}

/** A run of the clock, far longer than the stretch it is started again after. */
const LIFE_RUN_SECONDS = 24 * 60 * 60;
/** How long motion takes to ease in and out of the still picture. */
export const AWAKE_MS = 600;
/** The spring that turns the face into the typing dots and back: quick, barely overshooting. */
export const MORPH_SPRING = { duration: 520, dampingRatio: 0.8 } as const;

/** The shared avatar clock in seconds, which the UI thread's clock follows. */
function sharedSeconds(): number {
  return avatarSharedTimeMs() / 1000;
}

function untilNextStretchMs(): number {
  const window = AVATAR_SHARED_WINDOW_SECONDS * 1000;
  return window - (avatarSharedTimeMs() % window) + 1;
}

/**
 * Everything a moving avatar needs on the UI thread: a seconds clock, its 0–1 wake-up,
 * the clip timeline for its state, the typing-dots morph and the current tap poke. The
 * clock and timeline come from the shared avatar clock and the bot, so every copy of one
 * bot's avatar plays the same clip at the same moment.
 */
export function useLife(
  state: AvatarLifeState,
  clock: AvatarClock,
  size: number,
  mode: AvatarMotionMode,
  identity: string,
) {
  const seconds = useSharedValue(0);
  const awake = useSharedValue(0);
  // Only a running avatar turns into the typing dots. A still one stays a picture, and a
  // parked one (Reduce Motion) keeps its face and only blinks.
  const dots = state === "thinking" && clock === "running";
  const morph = useSharedValue(dots ? 1 : 0);
  const schedule = useSharedValue<AvatarSegment[]>([]);
  const poke = useSharedValue<AvatarPoke | null>(null);
  const pokeProgress = useSharedValue(1);
  const moving = clock !== "still";
  const pool = avatarClipPool(state, size, mode);
  useEffect(() => {
    awake.value = withTiming(clock === "running" ? 1 : 0, {
      duration: AWAKE_MS,
      easing: Easing.inOut(Easing.cubic),
    });
  }, [clock, awake]);
  useEffect(() => {
    morph.value = withSpring(dots ? 1 : 0, MORPH_SPRING);
  }, [dots, morph]);
  // Counts the stretches this avatar has planned and how long until the next begins, so
  // the timer is armed once a stretch, not on every render.
  const [stretch, setStretch] = useState(() => ({ count: 0, wait: untilNextStretchMs() }));
  // Whether a timeline was planned before, kept through a brief stop (a lazy avatar is
  // still for a render before it settles), so the next one eases from the pose on screen.
  // After a long stop that pose is stale, but `awake` eases in from the still picture.
  const planned = useRef(false);
  useEffect(() => {
    if (!moving) return;
    const now = sharedSeconds();
    // Easing in also finishes a bridge a new stretch would otherwise cut short; when the
    // pose on screen already matches the shared one, the timeline carries straight on.
    const from = planned.current ? avatarSchedulePose(schedule.value, now) : undefined;
    planned.current = true;
    // The timeline covers this stretch and the next.
    schedule.value = avatarSharedSchedule(pool, identity, now, from);
    // The UI thread's clock starts again from the shared clock with each plan, so it never
    // runs out or drifts from the timeline however long the avatar stays on screen. A new
    // timing replaces the running one; the clock stops only when the avatar does.
    seconds.value = now;
    seconds.value = withTiming(now + LIFE_RUN_SECONDS, {
      duration: LIFE_RUN_SECONDS * 1000,
      easing: Easing.linear,
      // The clock only ever drives blinks under Reduce Motion; it must keep ticking.
      reduceMotion: ReduceMotion.Never,
    });
  }, [moving, pool, identity, schedule, seconds, stretch.count]);
  useEffect(() => {
    if (moving) return () => cancelAnimation(seconds);
  }, [moving, seconds]);
  // A wait worked out before the avatar started moving may be off, but it is never longer
  // than a stretch and the timeline already covers the next one, so nothing runs out.
  useTimeout(
    () => setStretch(({ count }) => ({ count: count + 1, wait: untilNextStretchMs() })),
    moving ? stretch.wait : null,
    stretch.count,
  );
  return { seconds, awake, morph, schedule, poke, pokeProgress };
}

export type AvatarLife = ReturnType<typeof useLife>;

/** Plays the next tap reaction on a moving avatar. */
export function usePoke(life: Pick<AvatarLife, "poke" | "pokeProgress">, enabled: boolean) {
  const next = useRef(0);
  return () => {
    if (!enabled) return;
    const kind = AVATAR_POKES[next.current % AVATAR_POKES.length]!;
    next.current += 1;
    // The reaction runs on its own 0–1 clock on the UI thread. Reading the clip clock here
    // could lag behind the frames, and the reaction would look already over.
    life.poke.value = kind;
    life.pokeProgress.value = 0;
    life.pokeProgress.value = withTiming(1, {
      duration: AVATAR_POKE_SECONDS[kind] * 1000,
      easing: Easing.linear,
    });
  };
}

/** True for a moment after a bot goes back to rest, so its pose can spring home. */
export function useSettling(state: AvatarLifeState): boolean {
  const [settling, setSettling] = useState(false);
  // Counts returns to idle, so each one restarts the settle timer even if `settling` never dropped.
  const [settles, setSettles] = useState(0);
  const previous = useRef(state);
  useEffect(() => {
    const wasActive = previous.current !== "idle";
    previous.current = state;
    const settlesNow = state === "idle" && wasActive;
    setSettling(settlesNow);
    if (settlesNow) setSettles((count) => count + 1);
  }, [state]);
  useTimeout(() => setSettling(false), settling ? AVATAR_SETTLE_MS : null, settles);
  // The render that sees the bot stop already counts, so motion never blinks off and on.
  return settling || (state === "idle" && previous.current !== "idle");
}
