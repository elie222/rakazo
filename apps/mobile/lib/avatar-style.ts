import type { AvatarStyle } from "@rakazo/contracts";
import { AvatarStyleSchema } from "@rakazo/contracts";
import * as SecureStore from "expo-secure-store";

/** The last avatar style the server confirmed, so an offline launch starts from it. */
export const AVATAR_STYLE_KEY = "rakazo.avatar-style";

let memoryStyle: AvatarStyle | null = null;
/** What SecureStore holds. A failed write leaves this unchanged so the same style is retried. */
let storedStyle: AvatarStyle | null = null;
let revision = 0;
// One SecureStore change at a time, so an older save cannot land after a newer save or a deletion.
let writeChain: Promise<void> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function getCachedAvatarStyle(): AvatarStyle {
  return memoryStyle ?? "robot";
}

export async function loadAvatarStyle(): Promise<AvatarStyle> {
  const seen = revision;
  try {
    const stored = await SecureStore.getItemAsync(AVATAR_STYLE_KEY);
    // A save or clear that started after this read owns the cache.
    if (seen !== revision) return getCachedAvatarStyle();
    const parsed = AvatarStyleSchema.safeParse(stored).data ?? null;
    memoryStyle = parsed;
    storedStyle = parsed;
  } catch {
    // Keep the default when SecureStore is unavailable.
  }
  return getCachedAvatarStyle();
}

export function saveAvatarStyle(style: AvatarStyle): Promise<void> {
  const savedRevision = ++revision;
  memoryStyle = style;
  return enqueue(async () => {
    if (savedRevision !== revision) return;
    if (style === storedStyle) return;
    try {
      await SecureStore.setItemAsync(AVATAR_STYLE_KEY, style);
    } catch {
      // Disk still has the previous style, so a later save of this one must try again.
      return;
    }
    if (savedRevision !== revision) return;
    storedStyle = style;
  });
}

/** Removes the stored style. Returns false when the previous value is still on disk. */
export function clearAvatarStyle(): Promise<boolean> {
  const savedRevision = ++revision;
  const rememberedMemory = memoryStyle;
  const rememberedStored = storedStyle;
  memoryStyle = null;
  return enqueue(async () => {
    try {
      await SecureStore.deleteItemAsync(AVATAR_STYLE_KEY);
      storedStyle = null;
      return true;
    } catch {
      try {
        await SecureStore.setItemAsync(AVATAR_STYLE_KEY, "robot");
      } catch {
        if (savedRevision === revision) {
          memoryStyle = rememberedMemory;
          storedStyle = rememberedStored;
        }
        return false;
      }
      storedStyle = "robot";
      return true;
    }
  });
}

export type AvatarStyleClient = {
  refresh: () => void;
  update: (style: AvatarStyle) => Promise<void>;
};

/**
 * A read must not replace an update already in flight: that read can still be the previous style.
 */
export function createAvatarStyleClient(options: {
  read: () => Promise<AvatarStyle>;
  write: (style: AvatarStyle) => Promise<AvatarStyle>;
  publish: (style: AvatarStyle) => void;
  generation: () => number;
  save: (generation: number, style: AvatarStyle) => Promise<boolean>;
}): AvatarStyleClient {
  let refreshId = 0;
  let updateId = 0;
  let updateInFlight: Promise<void> | null = null;
  let refreshAfterUpdate = false;

  function refresh() {
    if (updateInFlight) {
      refreshAfterUpdate = true;
      return;
    }
    refreshAfterUpdate = false;
    const id = ++refreshId;
    const generation = options.generation();
    void options
      .read()
      .then(async (style) => {
        if (id !== refreshId || updateInFlight) return;
        if (generation !== options.generation()) return;
        if (!(await options.save(generation, style))) return;
        if (id !== refreshId || updateInFlight) return;
        if (generation !== options.generation()) return;
        options.publish(style);
      })
      .catch(() => undefined);
  }

  function update(style: AvatarStyle): Promise<void> {
    if (updateInFlight) return updateInFlight;
    const id = ++updateId;
    refreshId += 1;
    const generation = options.generation();
    const task = options
      .write(style)
      .then(async (confirmed) => {
        if (id !== updateId) return;
        if (generation !== options.generation()) return;
        if (!(await options.save(generation, confirmed))) return;
        if (id !== updateId) return;
        if (generation !== options.generation()) return;
        options.publish(confirmed);
      })
      .finally(() => {
        if (updateInFlight === task) updateInFlight = null;
        if (refreshAfterUpdate) refresh();
      });
    updateInFlight = task;
    return task;
  }

  return { refresh, update };
}
