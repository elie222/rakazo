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
  AVATAR_REST_POSE,
  AVATAR_SETTLE_MS,
  avatarClipPool,
  avatarSchedule,
  avatarSchedulePose,
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
import { useAppForeground } from "./app-foreground";

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

/** A clock long enough to never wrap while an avatar moves. */
const LIFE_RUN_SECONDS = 24 * 60 * 60;
/** How long motion takes to ease in and out of the still picture. */
export const AWAKE_MS = 600;
/** The spring that turns the face into the typing dots and back: quick, barely overshooting. */
export const MORPH_SPRING = { duration: 520, dampingRatio: 0.8 } as const;
/** The timeline is rebuilt this long before it runs out. */
const SCHEDULE_MARGIN_S = 5;

/**
 * The clip clock as the JS thread knows it: where it started and when (ms), or where it
 * stopped. The JS thread's read of a running animation can lag behind its frames.
 */
type ClockMirror = { base: number; since: number | null };
function clockNow({ base, since }: ClockMirror): number {
  return since === null ? base : base + (performance.now() - since) / 1000;
}

/**
 * Everything a moving avatar needs on the UI thread: a seconds clock, its 0–1 wake-up,
 * the clip timeline for its state, the typing-dots morph and the current tap poke.
 */
export function useLife(
  state: AvatarLifeState,
  clock: AvatarClock,
  size: number,
  mode: AvatarMotionMode,
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
  const mirror = useRef<ClockMirror>({ base: 0, since: null });
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
  useEffect(() => {
    if (!moving) return;
    // The JS thread sets where the clock starts, so it can tell the time without reading it.
    const start = clockNow(mirror.current);
    mirror.current = { base: start, since: performance.now() };
    seconds.value = start;
    seconds.value = withTiming(start + LIFE_RUN_SECONDS, {
      duration: LIFE_RUN_SECONDS * 1000,
      easing: Easing.linear,
      // The clock only ever drives blinks under Reduce Motion; it must keep ticking.
      reduceMotion: ReduceMotion.Never,
    });
    return () => {
      cancelAnimation(seconds);
      mirror.current = { base: clockNow(mirror.current), since: null };
    };
  }, [moving, seconds]);
  useEffect(() => {
    if (!moving) return;
    let timer: ReturnType<typeof setTimeout>;
    const plan = () => {
      // Pick up from wherever the head is now, as the next clip's bridge.
      const now = clockNow(mirror.current);
      const pose = schedule.value.length ? avatarSchedulePose(schedule.value, now) : undefined;
      const next = avatarSchedule(pool, now, pose ?? AVATAR_REST_POSE, Math.random);
      schedule.value = next;
      const last = next[next.length - 1];
      const remaining = last ? last.start + last.duration - now : 0;
      timer = setTimeout(plan, Math.max(remaining - SCHEDULE_MARGIN_S, 1) * 1000);
    };
    plan();
    return () => clearTimeout(timer);
  }, [moving, pool, schedule]);
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
  const previous = useRef(state);
  useEffect(() => {
    const wasActive = previous.current !== "idle";
    previous.current = state;
    if (state !== "idle" || !wasActive) {
      setSettling(false);
      return;
    }
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), AVATAR_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [state]);
  // The render that sees the bot stop already counts, so motion never blinks off and on.
  return settling || (state === "idle" && previous.current !== "idle");
}
