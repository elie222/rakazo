import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const native = vi.hoisted(() => ({
  os: "ios",
  appState: "active",
  appId: "com.rakazo.app" as string | null,
  module: {} as object | null,
  available: true,
  requestReview: vi.fn(async () => undefined),
  openUrl: vi.fn(async (_url: string) => undefined),
}));

const failRead = vi.hoisted(() => ({ on: false }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => {
    if (failRead.on) throw new Error("keychain locked");
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return native.appState;
    },
  },
  Platform: {
    get OS() {
      return native.os;
    },
  },
}));
vi.mock("expo-application", () => ({
  get applicationId() {
    return native.appId;
  },
}));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => native.module }));
vi.mock("expo-store-review", () => ({
  isAvailableAsync: async () => native.available,
  requestReview: native.requestReview,
}));
vi.mock("./open-url", () => ({ openExternalUrl: native.openUrl }));
vi.mock("./store-update", () => ({ OFFICIAL_BUNDLE_ID: "com.rakazo.app" }));

const DAY = 24 * 60 * 60_000;
const start = new Date(2026, 10, 2, 12).getTime();

async function load() {
  const review = await import("./store-review");
  review.resetStoreReviewForTests();
  return review;
}

/** Two days of use with three runs watched finish, the last one just now. */
async function engaged() {
  const review = await load();
  vi.setSystemTime(start);
  await review.askForReviewIfDue(() => true);
  review.noteRunCompleted();
  review.noteRunCompleted();
  vi.setSystemTime(start + DAY);
  review.noteRunCompleted();
  return review;
}

describe("store review prompt", () => {
  beforeEach(() => {
    store.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.clearAllMocks();
    failRead.on = false;
    Object.assign(native, {
      os: "ios",
      appState: "active",
      appId: "com.rakazo.app",
      module: {},
      available: true,
    });
  });

  it("asks once the person has used the app on two days and watched three runs finish", async () => {
    const review = await engaged();
    await review.askForReviewIfDue(() => true);
    expect(native.requestReview).toHaveBeenCalledOnce();

    review.noteRunCompleted();
    await review.askForReviewIfDue(() => true);
    expect(native.requestReview).toHaveBeenCalledOnce();
  });

  it("waits for a second day of use", async () => {
    const review = await load();
    vi.setSystemTime(start);
    for (let i = 0; i < 5; i++) review.noteRunCompleted();
    await review.askForReviewIfDue(() => true);
    expect(native.requestReview).not.toHaveBeenCalled();
  });

  it("asks only right after a run finished in this session", async () => {
    const review = await engaged();
    review.resetStoreReviewForTests();
    await review.askForReviewIfDue(() => true);
    expect(native.requestReview).not.toHaveBeenCalled();
  });

  it("asks again only after the wait, counting the saved state", async () => {
    const first = await engaged();
    await first.askForReviewIfDue(() => true);
    first.resetStoreReviewForTests();

    vi.setSystemTime(start + 30 * DAY);
    first.noteRunCompleted();
    await first.askForReviewIfDue(() => true);
    expect(native.requestReview).toHaveBeenCalledOnce();

    vi.setSystemTime(start + 125 * DAY);
    first.noteRunCompleted();
    await first.askForReviewIfDue(() => true);
    expect(native.requestReview).toHaveBeenCalledTimes(2);
  });

  it("does not carry a run past a check that was not due yet", async () => {
    const review = await load();
    vi.setSystemTime(start);
    for (let i = 0; i < 3; i++) review.noteRunCompleted();
    await review.askForReviewIfDue(() => true);
    vi.setSystemTime(start + DAY);
    await review.askForReviewIfDue(() => true);
    expect(native.requestReview).not.toHaveBeenCalled();
  });

  it("leaves the saved state alone when it cannot be read", async () => {
    const review = await engaged();
    await review.askForReviewIfDue(() => true);
    const saved = store.get("rakazo.store-review");
    review.resetStoreReviewForTests();

    failRead.on = true;
    review.noteRunCompleted();
    await expect(review.askForReviewIfDue(() => true)).rejects.toThrow("keychain locked");
    expect(store.get("rakazo.store-review")).toBe(saved);

    failRead.on = false;
    await review.askForReviewIfDue(() => true);
    expect(native.requestReview).toHaveBeenCalledOnce();
    expect(JSON.parse(store.get("rakazo.store-review") ?? "{}").askedAt).toBe(start + DAY);
  });

  it("keeps the chance when the inbox or the app left view before the prompt", async () => {
    const review = await engaged();
    await review.askForReviewIfDue(() => false);
    native.appState = "background";
    await review.askForReviewIfDue(() => true);
    expect(native.requestReview).not.toHaveBeenCalled();
    native.appState = "active";
    await review.askForReviewIfDue(() => true);
    expect(native.requestReview).toHaveBeenCalledOnce();
  });

  it.each([
    ["a fork's build", { appId: "com.example.fork" }],
    ["a build without the native module", { module: null }],
    ["a store that cannot prompt", { available: false }],
    ["the web", { os: "web" }],
  ])("never asks on %s", async (_name, overrides) => {
    Object.assign(native, overrides);
    const review = await engaged();
    await review.askForReviewIfDue(() => true);
    expect(native.requestReview).not.toHaveBeenCalled();
  });

  it("treats an unreadable saved state as a fresh start", async () => {
    const { parseReviewState } = await load();
    expect(parseReviewState("{not json")).toEqual({
      lastDay: null,
      activeDays: 0,
      completedRuns: 0,
      askedAt: null,
    });
    expect(parseReviewState('{"activeDays":-1,"completedRuns":"3","askedAt":5}')).toEqual({
      lastDay: null,
      activeDays: 0,
      completedRuns: 0,
      askedAt: 5,
    });
  });

  it("opens each store's write-a-review page, and none for a fork", async () => {
    const review = await load();
    review.openWriteReview();
    expect(native.openUrl).toHaveBeenLastCalledWith(
      "https://apps.apple.com/app/rakazo/id6801531099?action=write-review",
    );
    native.os = "android";
    review.openWriteReview();
    expect(native.openUrl).toHaveBeenLastCalledWith(
      "https://play.google.com/store/apps/details?id=com.rakazo.app",
    );
    native.appId = "com.example.fork";
    expect(review.writeReviewUrl()).toBeNull();
  });
});
