import type { LogoAvatarActivity } from "@rakazo/core";
import { useSyncExternalStore } from "react";
import type { ImageSourcePropType } from "react-native";

/** The expression packs a bot's avatar can use. "chief" is the default Q-style assistant. */
export type ExpressionPack = "chief" | "off";

const EXPRESSION_PACK_KEY = "rakazo.expression-pack";

/** The six faces of the chief pack, one per activity state. */
const CHIEF_IMAGES: Record<string, ImageSourcePropType> = {
  thinking: require("../assets/avatar-expressions/thinking.png"),
  searching: require("../assets/avatar-expressions/searching.png"),
  working: require("../assets/avatar-expressions/working.png"),
  waiting: require("../assets/avatar-expressions/waiting.png"),
  done: require("../assets/avatar-expressions/done.png"),
  error: require("../assets/avatar-expressions/error.png"),
};

/** Which chief face an activity shows. Idle rests on the thinking face. */
export function expressionImageFor(
  activity: LogoAvatarActivity,
  justFinished = false,
): ImageSourcePropType {
  if (justFinished) return CHIEF_IMAGES.done!;
  switch (activity) {
    case "reading":
      return CHIEF_IMAGES.searching!;
    case "writing":
    case "computer":
    case "working":
      return CHIEF_IMAGES.working!;
    case "waiting":
      return CHIEF_IMAGES.waiting!;
    case "error":
      return CHIEF_IMAGES.error!;
    default:
      return CHIEF_IMAGES.thinking!;
  }
}

/** The chief pack's faces, for the avatar editor's gallery. */
export function chiefExpressionGallery(): { id: string; image: ImageSourcePropType }[] {
  return [
    { id: "thinking", image: CHIEF_IMAGES.thinking! },
    { id: "searching", image: CHIEF_IMAGES.searching! },
    { id: "working", image: CHIEF_IMAGES.working! },
    { id: "waiting", image: CHIEF_IMAGES.waiting! },
    { id: "done", image: CHIEF_IMAGES.done! },
    { id: "error", image: CHIEF_IMAGES.error! },
  ];
}

type PackMap = Record<string, ExpressionPack>;
let packs: PackMap = {};
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

async function loadPacks(): Promise<void> {
  if (loaded) return;
  if (!loading) {
    loading = (async () => {
      try {
        // Deferred so importing this module never pulls the native store into tests.
        const SecureStore = await import("expo-secure-store");
        const stored = JSON.parse(
          (await SecureStore.getItemAsync(EXPRESSION_PACK_KEY)) ?? "null",
        ) as PackMap | null;
        if (stored && typeof stored === "object") packs = stored;
      } catch {
        // Unreadable storage keeps every bot on the default pack.
      }
      loaded = true;
      notify();
    })();
  }
  await loading;
}

let saving: Promise<void> = Promise.resolve();

/** The pack a bot's avatar uses. Chief is the default; "off" keeps the regular avatar. */
export function expressionPackFor(botId: string | undefined): ExpressionPack {
  if (!botId) return "chief";
  return packs[botId] ?? "chief";
}

export function useExpressionPack(botId: string | undefined): ExpressionPack {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      void loadPacks();
      return () => {
        listeners.delete(listener);
      };
    },
    () => expressionPackFor(botId),
  );
  return expressionPackFor(botId);
}

/** Switches a bot's expression pack; the change is local to this device. */
export function setExpressionPack(botId: string, pack: ExpressionPack): void {
  packs = { ...packs, [botId]: pack };
  notify();
  const value = JSON.stringify(packs);
  saving = saving
    .then(async () => {
      const SecureStore = await import("expo-secure-store");
      await SecureStore.setItemAsync(EXPRESSION_PACK_KEY, value);
    })
    .catch(() => undefined);
}
