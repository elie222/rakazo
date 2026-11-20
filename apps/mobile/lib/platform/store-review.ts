import { ANDROID_APP_STORE_URL, IOS_APP_STORE_URL } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import * as Application from "expo-application";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";
import { openExternalUrl } from "./open-url";
import { OFFICIAL_BUNDLE_ID } from "./store-update";

const STORAGE_KEY = "rakazo.store-review";
const MIN_ACTIVE_DAYS = 2;
const MIN_COMPLETED_RUNS = 3;
const ASK_AGAIN_AFTER_MS = 120 * 24 * 60 * 60_000;

export type ReviewState = {
  lastDay: string | null;
  activeDays: number;
  completedRuns: number;
  askedAt: number | null;
};

const EMPTY: ReviewState = { lastDay: null, activeDays: 0, completedRuns: 0, askedAt: null };

let state: Promise<ReviewState> | null = null;
// Set by a run that finished in front of the person this session; the next inbox visit asks.
let winPending = false;
let asking = false;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function parseReviewState(raw: string | null): ReviewState {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      lastDay: typeof value.lastDay === "string" ? value.lastDay : null,
      activeDays: count(value.activeDays),
      completedRuns: count(value.completedRuns),
      askedAt: typeof value.askedAt === "number" ? value.askedAt : null,
    };
  } catch {
    return EMPTY;
  }
}

export function reviewDue(current: ReviewState, now: number): boolean {
  return (
    current.activeDays >= MIN_ACTIVE_DAYS &&
    current.completedRuns >= MIN_COMPLETED_RUNS &&
    (current.askedAt === null || now - current.askedAt >= ASK_AGAIN_AFTER_MS)
  );
}

function update(change: (current: ReviewState) => ReviewState): Promise<ReviewState> {
  const previous = state ?? SecureStore.getItemAsync(STORAGE_KEY).then(parseReviewState);
  // Each save finishes before the next change starts, so the stored state follows their order.
  const next = previous.then(async (current) => {
    const value = change(current);
    await bestEffort(
      "store review state save",
      SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(value)),
    );
    return value;
  });
  state = next;
  // A failed read is not kept, so the next change reads again instead of saving over the stored state.
  next.catch(() => {
    if (state === next) state = null;
  });
  return next;
}

/** Store builds of the official app only: a fork or dev build has no listing of its own. */
function officialStoreBuild(): boolean {
  return (
    (Platform.OS === "ios" || Platform.OS === "android") &&
    Application.applicationId === OFFICIAL_BUNDLE_ID
  );
}

/** A run the person watched finish. */
export function noteRunCompleted(): void {
  winPending = true;
  void bestEffort(
    "store review run count",
    update((current) => ({ ...current, completedRuns: current.completedRuns + 1 })),
  );
}

/**
 * Called when the inbox comes into view. Records the day, and right after a run the person
 * watched finish, asks the store's own rating prompt once they have used the app enough. The
 * store decides whether the prompt actually shows.
 */
export async function askForReviewIfDue(isActive: () => boolean): Promise<void> {
  const now = Date.now();
  const today = new Date(now).toDateString();
  const current = await update((value) =>
    value.lastDay === today
      ? value
      : { ...value, lastDay: today, activeDays: value.activeDays + 1 },
  );
  if (!winPending || asking) return;
  winPending = false;
  if (!reviewDue(current, now) || !officialStoreBuild()) return;
  // An over-the-air update can reach a build made before the module was added.
  if (!requireOptionalNativeModule("ExpoStoreReview")) return;
  asking = true;
  try {
    const StoreReview = await import("expo-store-review");
    if (!(await StoreReview.isAvailableAsync())) return;
    if (!isActive() || AppState.currentState !== "active") {
      winPending = true;
      return;
    }
    await StoreReview.requestReview();
    await update((value) => ({ ...value, askedAt: now }));
  } finally {
    asking = false;
  }
}

/** The store page to write a review on, for official store builds. */
export function writeReviewUrl(): string | null {
  if (!officialStoreBuild()) return null;
  return Platform.OS === "ios" ? `${IOS_APP_STORE_URL}?action=write-review` : ANDROID_APP_STORE_URL;
}

export function openWriteReview(): void {
  const url = writeReviewUrl();
  if (url) void openExternalUrl(url);
}

/** Test-only: forget the loaded state. */
export function resetStoreReviewForTests(): void {
  state = null;
  winPending = false;
  asking = false;
}
