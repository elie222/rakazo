import { beforeEach, describe, expect, it, vi } from "vitest";

const { native, values, storage, feedback } = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    native: {
      Platform: { OS: "ios", Version: 34 },
      AppState: { currentState: "active" as string | null },
    },
    values,
    storage: {
      getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
      setItemAsync: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    },
    feedback: {
      selectionAsync: vi.fn(async () => undefined),
      impactAsync: vi.fn(async (_style: string) => undefined),
      notificationAsync: vi.fn(async (_type: string) => undefined),
      performAndroidHapticsAsync: vi.fn(async (_type: string) => undefined),
      AndroidHaptics: {
        Segment_Tick: "segment-tick",
        Context_Click: "context-click",
        Clock_Tick: "clock-tick",
        Confirm: "confirm",
      },
      ImpactFeedbackStyle: { Light: "light" },
      NotificationFeedbackType: { Success: "success" },
    },
  };
});

vi.mock("react-native", () => native);
vi.mock("expo-secure-store", () => storage);
vi.mock("expo-haptics", () => feedback);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function expectNoFeedback(): void {
  expect(feedback.selectionAsync).not.toHaveBeenCalled();
  expect(feedback.impactAsync).not.toHaveBeenCalled();
  expect(feedback.notificationAsync).not.toHaveBeenCalled();
  expect(feedback.performAndroidHapticsAsync).not.toHaveBeenCalled();
}

describe("mobile haptics", () => {
  beforeEach(() => {
    vi.resetModules();
    values.clear();
    native.Platform.OS = "ios";
    native.Platform.Version = 34;
    native.AppState.currentState = "active";
    storage.getItemAsync.mockReset().mockImplementation(async (key) => values.get(key) ?? null);
    storage.setItemAsync.mockReset().mockImplementation(async (key, value) => {
      values.set(key, value);
    });
    for (const method of [
      feedback.selectionAsync,
      feedback.impactAsync,
      feedback.notificationAsync,
      feedback.performAndroidHapticsAsync,
    ]) {
      method.mockReset().mockResolvedValue(undefined);
    }
  });

  it("defaults to enabled but stays silent until the saved preference has loaded", async () => {
    const haptics = await import("./haptics");
    expect(haptics.getHapticsEnabled()).toBe(true);
    haptics.hapticSelection();
    haptics.hapticImpact();
    haptics.hapticSuccess();
    expectNoFeedback();

    await haptics.loadHapticsPreference();
    expect(haptics.getHapticsEnabled()).toBe(true);
    expect(haptics.hapticSelection()).toBeUndefined();
    expect(feedback.selectionAsync).toHaveBeenCalledOnce();
  });

  it("keeps startup taps silent while a disabled preference is still being read", async () => {
    const read = deferred<string | null>();
    storage.getItemAsync.mockReturnValue(read.promise);
    const haptics = await import("./haptics");
    const loading = haptics.loadHapticsPreference();
    haptics.hapticSelection();
    haptics.hapticImpact();
    haptics.hapticSuccess();
    expectNoFeedback();
    read.resolve("false");
    await loading;
    expect(haptics.getHapticsEnabled()).toBe(false);
    haptics.hapticSelection();
    haptics.hapticImpact();
    haptics.hapticSuccess();
    expectNoFeedback();
  });

  it("shares a single initial storage read", async () => {
    const read = deferred<string | null>();
    storage.getItemAsync.mockReturnValue(read.promise);
    const { loadHapticsPreference } = await import("./haptics");
    const first = loadHapticsPreference();
    expect(loadHapticsPreference()).toBe(first);
    await Promise.resolve();
    expect(storage.getItemAsync).toHaveBeenCalledOnce();
    read.resolve(null);
    await first;
    await loadHapticsPreference();
    expect(storage.getItemAsync).toHaveBeenCalledOnce();
  });

  it("uses selection, light impact, and success feedback on iOS", async () => {
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    expect(haptics.hapticSelection()).toBeUndefined();
    expect(haptics.hapticImpact()).toBeUndefined();
    expect(haptics.hapticSuccess()).toBeUndefined();
    expect(feedback.selectionAsync).toHaveBeenCalledOnce();
    expect(feedback.impactAsync).toHaveBeenCalledExactlyOnceWith("light");
    expect(feedback.notificationAsync).toHaveBeenCalledExactlyOnceWith("success");
    expect(feedback.performAndroidHapticsAsync).not.toHaveBeenCalled();
  });

  it("uses Android system haptic constants instead of the vibrator-backed iOS APIs", async () => {
    native.Platform.OS = "android";
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    haptics.hapticSelection();
    haptics.hapticImpact();
    haptics.hapticSuccess();
    expect(feedback.performAndroidHapticsAsync.mock.calls).toEqual([
      ["segment-tick"],
      ["context-click"],
      ["confirm"],
    ]);
    expect(feedback.selectionAsync).not.toHaveBeenCalled();
    expect(feedback.impactAsync).not.toHaveBeenCalled();
    expect(feedback.notificationAsync).not.toHaveBeenCalled();
  });

  it.each([
    [24, ["clock-tick", "context-click", "context-click"]],
    [29, ["clock-tick", "context-click", "context-click"]],
    [33, ["clock-tick", "context-click", "confirm"]],
  ] as const)("uses supported system feedback on Android API %s", async (api, expected) => {
    native.Platform.OS = "android";
    native.Platform.Version = api;
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    haptics.hapticSelection();
    haptics.hapticImpact();
    haptics.hapticSuccess();
    expect(feedback.performAndroidHapticsAsync.mock.calls.map(([type]) => type)).toEqual(expected);
    expect(feedback.selectionAsync).not.toHaveBeenCalled();
    expect(feedback.impactAsync).not.toHaveBeenCalled();
    expect(feedback.notificationAsync).not.toHaveBeenCalled();
  });

  it.each(["background", "inactive", "unknown", null])(
    "stays silent when the app state is %s",
    async (state) => {
      const haptics = await import("./haptics");
      await haptics.loadHapticsPreference();
      native.AppState.currentState = state;
      haptics.hapticSelection();
      haptics.hapticImpact();
      haptics.hapticSuccess();
      expectNoFeedback();
    },
  );

  it("does nothing on unsupported platforms", async () => {
    native.Platform.OS = "web";
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    haptics.hapticSelection();
    haptics.hapticImpact();
    haptics.hapticSuccess();
    expectNoFeedback();
  });

  it("applies a toggle immediately while the device save is pending", async () => {
    const save = deferred<void>();
    storage.setItemAsync.mockReturnValue(save.promise);
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    const listener = vi.fn();
    const unsubscribe = haptics.subscribeHaptics(listener);
    const pending = haptics.setHapticsEnabled(false);
    expect(haptics.getHapticsEnabled()).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    haptics.hapticSelection();
    expectNoFeedback();
    save.resolve();
    await pending;
    unsubscribe();
    await haptics.setHapticsEnabled(true);
    expect(listener).toHaveBeenCalledOnce();
    haptics.hapticSelection();
    expect(feedback.selectionAsync).toHaveBeenCalledOnce();
  });

  it("notifies subscribers when a saved preference has loaded", async () => {
    values.set("rakazo.haptics", "false");
    const haptics = await import("./haptics");
    const listener = vi.fn();
    haptics.subscribeHaptics(listener);
    await haptics.loadHapticsPreference();
    expect(listener).toHaveBeenCalledOnce();
    expect(haptics.getHapticsEnabled()).toBe(false);
  });

  it("never lets a stale initial read undo a choice made during that read", async () => {
    const read = deferred<string | null>();
    storage.getItemAsync.mockReturnValue(read.promise);
    const haptics = await import("./haptics");
    const loading = haptics.loadHapticsPreference();
    await haptics.setHapticsEnabled(false);
    read.resolve("true");
    await loading;
    expect(haptics.getHapticsEnabled()).toBe(false);
    haptics.hapticSuccess();
    expectNoFeedback();
  });

  it("keeps an explicit choice made before the initial read starts", async () => {
    storage.getItemAsync.mockResolvedValue("true");
    const haptics = await import("./haptics");
    await haptics.setHapticsEnabled(false);
    await haptics.loadHapticsPreference();
    expect(haptics.getHapticsEnabled()).toBe(false);
  });

  it("serializes rapid saves so the final choice survives a reload", async () => {
    const firstSave = deferred<void>();
    storage.setItemAsync.mockImplementationOnce(async (key, value) => {
      await firstSave.promise;
      values.set(key, value);
    });
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    const first = haptics.setHapticsEnabled(false);
    const second = haptics.setHapticsEnabled(true);
    const third = haptics.setHapticsEnabled(false);
    expect(haptics.getHapticsEnabled()).toBe(false);
    await Promise.resolve();
    expect(storage.setItemAsync).toHaveBeenCalledTimes(1);
    firstSave.resolve();
    await Promise.all([first, second, third]);
    expect(storage.setItemAsync.mock.calls).toEqual([
      ["rakazo.haptics", "false"],
      ["rakazo.haptics", "true"],
      ["rakazo.haptics", "false"],
    ]);
    vi.resetModules();
    const reloaded = await import("./haptics");
    await reloaded.loadHapticsPreference();
    expect(reloaded.getHapticsEnabled()).toBe(false);
  });

  it("keeps feedback gated when a stored off preference cannot be read", async () => {
    values.set("rakazo.haptics", "false");
    storage.getItemAsync.mockRejectedValue(new Error("storage unavailable"));
    const haptics = await import("./haptics");
    await expect(haptics.loadHapticsPreference()).resolves.toBeUndefined();
    haptics.hapticSelection();
    haptics.hapticImpact();
    haptics.hapticSuccess();
    expectNoFeedback();
    await haptics.loadHapticsPreference();
    expectNoFeedback();
    expect(values.get("rakazo.haptics")).toBe("false");
  });

  it("allows an explicit on choice to recover from an unread saved preference", async () => {
    values.set("rakazo.haptics", "false");
    storage.getItemAsync.mockRejectedValue(new Error("storage unavailable"));
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    haptics.hapticSelection();
    expectNoFeedback();
    await haptics.setHapticsEnabled(true);
    haptics.hapticSelection();
    haptics.hapticImpact();
    haptics.hapticSuccess();
    expect(feedback.selectionAsync).toHaveBeenCalledOnce();
    expect(feedback.impactAsync).toHaveBeenCalledExactlyOnceWith("light");
    expect(feedback.notificationAsync).toHaveBeenCalledExactlyOnceWith("success");
    expect(values.get("rakazo.haptics")).toBe("true");
  });

  it.each([false, true])(
    "honors an explicit %s choice before a late read failure",
    async (value) => {
      let failRead!: (error: Error) => void;
      storage.getItemAsync.mockReturnValue(
        new Promise<never>((_resolve, reject) => {
          failRead = reject;
        }),
      );
      const save = deferred<void>();
      storage.setItemAsync.mockReturnValue(save.promise);
      const haptics = await import("./haptics");
      const loading = haptics.loadHapticsPreference();
      const writing = haptics.setHapticsEnabled(value);
      haptics.hapticSelection();
      expect(feedback.selectionAsync).toHaveBeenCalledTimes(value ? 1 : 0);
      await Promise.resolve();
      failRead(new Error("late read failure"));
      await loading;
      expect(haptics.getHapticsEnabled()).toBe(value);
      haptics.hapticSuccess();
      expect(feedback.notificationAsync).toHaveBeenCalledTimes(value ? 1 : 0);
      save.resolve();
      await writing;
    },
  );

  it.each(["false", "true"])(
    "retries an unread saved %s preference and caches its successful read",
    async (stored) => {
      values.set("rakazo.haptics", stored);
      storage.getItemAsync.mockRejectedValueOnce(new Error("temporarily unavailable"));
      const haptics = await import("./haptics");
      await haptics.loadHapticsPreference();
      haptics.hapticSelection();
      expectNoFeedback();
      const retry = haptics.loadHapticsPreference();
      expect(haptics.loadHapticsPreference()).toBe(retry);
      await retry;
      expect(haptics.getHapticsEnabled()).toBe(stored === "true");
      haptics.hapticSelection();
      expect(feedback.selectionAsync).toHaveBeenCalledTimes(stored === "true" ? 1 : 0);
      await haptics.loadHapticsPreference();
      expect(storage.getItemAsync).toHaveBeenCalledTimes(2);
    },
  );

  it("can retry storage that throws synchronously without caching the failed task", async () => {
    values.set("rakazo.haptics", "false");
    storage.getItemAsync.mockImplementationOnce(() => {
      throw new Error("sync storage failure");
    });
    const haptics = await import("./haptics");
    const first = haptics.loadHapticsPreference();
    expect(haptics.loadHapticsPreference()).toBe(first);
    await first;
    haptics.hapticSelection();
    expectNoFeedback();
    await haptics.loadHapticsPreference();
    expect(haptics.getHapticsEnabled()).toBe(false);
    expect(storage.getItemAsync).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer explicit choice when retrying an earlier failed read", async () => {
    values.set("rakazo.haptics", "false");
    storage.getItemAsync.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    const retry = haptics.loadHapticsPreference();
    const saving = haptics.setHapticsEnabled(true);
    await Promise.all([retry, saving]);
    expect(haptics.getHapticsEnabled()).toBe(true);
    haptics.hapticSelection();
    expect(feedback.selectionAsync).toHaveBeenCalledOnce();
  });

  it.each(["false", "true"])(
    "recovers a saved %s preference on demand without replaying gestures",
    async (stored) => {
      values.set("rakazo.haptics", stored);
      const read = deferred<string | null>();
      storage.getItemAsync
        .mockRejectedValueOnce(new Error("startup read failed"))
        .mockReturnValueOnce(read.promise);
      const haptics = await import("./haptics");
      await haptics.loadHapticsPreference();
      expect(storage.getItemAsync).toHaveBeenCalledOnce();
      haptics.hapticSelection();
      haptics.hapticImpact();
      haptics.hapticSuccess();
      await Promise.resolve();
      expect(storage.getItemAsync).toHaveBeenCalledTimes(2);
      expectNoFeedback();
      const recovery = haptics.loadHapticsPreference();
      read.resolve(stored);
      await recovery;
      expectNoFeedback();
      haptics.hapticSelection();
      haptics.hapticImpact();
      haptics.hapticSuccess();
      const count = stored === "true" ? 1 : 0;
      expect(feedback.selectionAsync).toHaveBeenCalledTimes(count);
      expect(feedback.impactAsync).toHaveBeenCalledTimes(count);
      expect(feedback.notificationAsync).toHaveBeenCalledTimes(count);
      expect(storage.getItemAsync).toHaveBeenCalledTimes(2);
    },
  );

  it("retries another failed recovery only when a later gesture asks for feedback", async () => {
    values.set("rakazo.haptics", "true");
    storage.getItemAsync
      .mockRejectedValueOnce(new Error("startup read failed"))
      .mockRejectedValueOnce(new Error("recovery read failed"));
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    haptics.hapticImpact();
    await Promise.resolve();
    expect(storage.getItemAsync).toHaveBeenCalledTimes(2);
    await haptics.loadHapticsPreference();
    expectNoFeedback();
    expect(storage.getItemAsync).toHaveBeenCalledTimes(2);
    haptics.hapticImpact();
    await Promise.resolve();
    expect(storage.getItemAsync).toHaveBeenCalledTimes(3);
    await haptics.loadHapticsPreference();
    expectNoFeedback();
    haptics.hapticImpact();
    expect(feedback.impactAsync).toHaveBeenCalledExactlyOnceWith("light");
    expect(storage.getItemAsync).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["ios", "background"],
    ["ios", "inactive"],
    ["ios", null],
    ["web", "active"],
  ] as const)("does not read an unknown preference on %s while %s", async (platform, state) => {
    native.Platform.OS = platform;
    native.AppState.currentState = state;
    const haptics = await import("./haptics");
    haptics.hapticSelection();
    haptics.hapticImpact();
    haptics.hapticSuccess();
    await Promise.resolve();
    expect(storage.getItemAsync).not.toHaveBeenCalled();
    expectNoFeedback();
  });

  it("keeps memory after a failed save and still persists the next toggle", async () => {
    storage.setItemAsync.mockRejectedValueOnce(new Error("storage unavailable"));
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    await expect(haptics.setHapticsEnabled(false)).rejects.toThrow("storage unavailable");
    expect(haptics.getHapticsEnabled()).toBe(false);
    haptics.hapticSelection();
    expectNoFeedback();
    await haptics.setHapticsEnabled(true);
    expect(values.get("rakazo.haptics")).toBe("true");
  });

  it("persists a retried off choice after reporting its first save failure", async () => {
    storage.setItemAsync.mockRejectedValueOnce(new Error("storage unavailable"));
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    await expect(haptics.setHapticsEnabled(false)).rejects.toThrow("storage unavailable");
    expect(haptics.getHapticsEnabled()).toBe(false);
    await haptics.setHapticsEnabled(false);
    expect(values.get("rakazo.haptics")).toBe("false");
    vi.resetModules();
    const reloaded = await import("./haptics");
    await reloaded.loadHapticsPreference();
    expect(reloaded.getHapticsEnabled()).toBe(false);
  });

  it("reports each queued write's own error while continuing with newer toggles", async () => {
    const firstError = new Error("first failed");
    const secondError = new Error("second failed");
    storage.setItemAsync.mockRejectedValueOnce(firstError).mockRejectedValueOnce(secondError);
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    const first = haptics.setHapticsEnabled(false);
    const second = haptics.setHapticsEnabled(true);
    const third = haptics.setHapticsEnabled(false);
    expect(haptics.getHapticsEnabled()).toBe(false);
    await expect(first).rejects.toBe(firstError);
    await expect(second).rejects.toBe(secondError);
    await third;
    expect(storage.setItemAsync.mock.calls).toEqual([
      ["rakazo.haptics", "false"],
      ["rakazo.haptics", "true"],
      ["rakazo.haptics", "false"],
    ]);
    expect(values.get("rakazo.haptics")).toBe("false");
  });

  it("swallows synchronous and rejected native failures", async () => {
    const haptics = await import("./haptics");
    await haptics.loadHapticsPreference();
    feedback.selectionAsync.mockImplementationOnce(() => {
      throw new Error("native module unavailable");
    });
    feedback.impactAsync.mockRejectedValueOnce(new Error("native request failed"));
    feedback.notificationAsync.mockRejectedValueOnce(new Error("unsupported device"));
    expect(() => {
      haptics.hapticSelection();
      haptics.hapticImpact();
      haptics.hapticSuccess();
    }).not.toThrow();
    await Promise.resolve();
    native.Platform.OS = "android";
    feedback.performAndroidHapticsAsync.mockRejectedValueOnce(new Error("unsupported device"));
    expect(haptics.hapticSelection()).toBeUndefined();
    await Promise.resolve();
  });
});
