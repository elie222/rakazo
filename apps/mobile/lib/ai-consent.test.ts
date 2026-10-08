import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  const appState = {
    currentState: "active",
    addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return { remove: vi.fn(() => listeners.delete(listener)) };
    }),
  };
  return {
    alert: vi.fn(),
    appState,
    emit(state: string) {
      appState.currentState = state;
      for (const listener of listeners) listener(state);
    },
    listeners,
    openURL: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("react-native", () => ({
  Alert: { alert: native.alert },
  AppState: native.appState,
  Linking: { openURL: native.openURL },
}));

import type { AiRecipient } from "@rakazo/contracts";
import { AI_DATA_DISCLOSURES } from "@rakazo/contracts";
import { Alert } from "react-native";
import { FOREGROUND_FALLBACK_MS, promptAiConsent } from "./ai-consent";
import { resetI18nForTests, t } from "./i18n";

type AlertButton = { text?: string; onPress?: () => void };
type AlertOptions = { onDismiss?: () => void };

const recipient: AiRecipient = {
  key: "provider",
  name: "Example AI",
  use: "model",
  detail: "Messages are sent to Example AI to generate replies.",
  allowed: false,
};

function currentAlert() {
  const call = vi.mocked(Alert.alert).mock.calls.at(-1);
  if (!call) throw new Error("Expected an AI consent alert");
  return {
    buttons: (call[2] ?? []) as AlertButton[],
    options: (call[3] ?? {}) as AlertOptions,
  };
}

function flushTimers() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("mobile AI consent prompt", () => {
  beforeEach(() => {
    resetI18nForTests();
    vi.useRealTimers();
    native.alert.mockReset();
    native.openURL.mockReset().mockResolvedValue(undefined);
    native.appState.currentState = "active";
    native.listeners.clear();
  });

  it.each(["en", "de", "ru", "zh-CN"] as const)(
    "translates the consent copy in %s without changing recipient detail",
    async (locale) => {
      resetI18nForTests(locale);
      const pending = promptAiConsent(recipient);
      expect(native.alert.mock.calls[0]?.slice(0, 2)).toEqual([
        t("Share data with {name}?", { name: recipient.name }),
        [
          recipient.detail,
          t(AI_DATA_DISCLOSURES.model),
          t("You can turn this off in Account → AI data sharing."),
        ].join("\n\n"),
      ]);
      expect(currentAlert().buttons.map((button) => button.text)).toEqual([
        t("Not now"),
        t("Privacy policy"),
        t("Allow"),
      ]);
      currentAlert().buttons[0]?.onPress?.();
      await expect(pending).resolves.toBe(false);
    },
  );

  it("omits empty details from the consent message", async () => {
    const pending = promptAiConsent({ ...recipient, detail: "" });
    expect(native.alert.mock.calls[0]?.[1]).toBe(
      `${AI_DATA_DISCLOSURES.model}\n\nYou can turn this off in Account → AI data sharing.`,
    );
    currentAlert().buttons[0]?.onPress?.();
    await expect(pending).resolves.toBe(false);
  });

  it("settles refusal once and does not reopen when Android dismisses the alert", async () => {
    const pending = promptAiConsent(recipient, "https://example.com/privacy");
    const first = currentAlert();

    first.buttons[0]?.onPress?.();
    first.options.onDismiss?.();

    await expect(pending).resolves.toBe(false);
    expect(native.alert).toHaveBeenCalledOnce();
    expect(native.openURL).not.toHaveBeenCalled();
  });

  it("keeps consent pending through a privacy-policy round trip and reopens a usable choice", async () => {
    let settled = false;
    native.openURL.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = promptAiConsent(recipient, "https://example.com/privacy").then((value) => {
      settled = true;
      return value;
    });
    const first = currentAlert();

    first.buttons[1]?.onPress?.();
    expect(native.openURL).toHaveBeenCalledWith("https://example.com/privacy");
    expect(native.openURL).toHaveBeenCalledTimes(1);

    // A trailing native dismiss callback may occur before or after the app becomes active.
    native.emit("background");
    native.emit("active");
    first.options.onDismiss?.();
    await flushTimers();

    expect(settled).toBe(false);
    expect(native.alert).toHaveBeenCalledTimes(2);
    const second = currentAlert();
    expect(second.buttons.map((button) => button.text)).toEqual([
      "Not now",
      "Privacy policy",
      "Allow",
    ]);

    second.buttons[2]?.onPress?.();
    await expect(pending).resolves.toBe(true);
    expect(settled).toBe(true);
  });

  it("reopens on iOS when the app returns without an onDismiss callback", async () => {
    native.openURL.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = promptAiConsent(recipient, "https://example.com/privacy");
    const first = currentAlert();

    first.buttons[1]?.onPress?.();
    // iOS calls the button callback but does not invoke AlertOptions.onDismiss.
    native.emit("background");
    native.emit("active");
    await flushTimers();

    expect(native.alert).toHaveBeenCalledTimes(2);
    currentAlert().buttons[2]?.onPress?.();
    await expect(pending).resolves.toBe(true);
  });

  it("does not let a delayed policy dismissal cancel the replacement alert", async () => {
    native.openURL.mockImplementationOnce(() => new Promise(() => undefined));
    let settled = false;
    const pending = promptAiConsent(recipient, "https://example.com/privacy").then((value) => {
      settled = true;
      return value;
    });
    const first = currentAlert();

    first.buttons[1]?.onPress?.();
    native.emit("background");
    native.emit("active");
    await flushTimers();

    expect(native.alert).toHaveBeenCalledTimes(2);
    const second = currentAlert();
    first.options.onDismiss?.();
    second.options.onDismiss?.();
    await flushTimers();

    expect(settled).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it("ignores a stale privacy open after a later policy attempt starts", async () => {
    let resolveFirst: (() => void) | undefined;
    native.openURL
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(() => new Promise(() => undefined));
    let settled = false;
    const pending = promptAiConsent(recipient, "https://example.com/privacy").then((value) => {
      settled = true;
      return value;
    });
    const first = currentAlert();

    first.buttons[1]?.onPress?.();
    native.emit("background");
    native.emit("active");
    await flushTimers();

    expect(native.alert).toHaveBeenCalledTimes(2);
    currentAlert().buttons[1]?.onPress?.();
    expect(native.openURL).toHaveBeenCalledTimes(2);

    resolveFirst?.();
    await flushTimers();
    await flushTimers();

    expect(settled).toBe(false);
    expect(native.alert).toHaveBeenCalledTimes(2);
    expect(native.openURL).toHaveBeenCalledTimes(2);
    native.emit("background");
    native.emit("active");
    await flushTimers();

    expect(native.alert).toHaveBeenCalledTimes(3);
    currentAlert().buttons[2]?.onPress?.();
    await expect(pending).resolves.toBe(true);
    expect(settled).toBe(true);
  });

  it("reopens the choice when the policy stays in the foreground", async () => {
    vi.useFakeTimers();
    const pending = promptAiConsent(recipient, "https://example.com/privacy");
    const first = currentAlert();

    first.buttons[1]?.onPress?.();
    await vi.advanceTimersByTimeAsync(FOREGROUND_FALLBACK_MS - 1);
    expect(native.alert).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(native.openURL).toHaveBeenCalledWith("https://example.com/privacy");
    expect(native.alert).toHaveBeenCalledTimes(2);
    currentAlert().buttons[2]?.onPress?.();
    await expect(pending).resolves.toBe(true);
  });

  it("reopens after the app leaves before the foreground fallback", async () => {
    vi.useFakeTimers();
    const pending = promptAiConsent(recipient, "https://example.com/privacy");
    const first = currentAlert();

    first.buttons[1]?.onPress?.();
    await vi.advanceTimersByTimeAsync(0);
    native.emit("inactive");
    await vi.advanceTimersByTimeAsync(FOREGROUND_FALLBACK_MS);

    expect(native.alert).toHaveBeenCalledTimes(1);
    native.emit("active");
    await vi.advanceTimersByTimeAsync(0);

    expect(native.alert).toHaveBeenCalledTimes(2);
    currentAlert().buttons[2]?.onPress?.();
    await expect(pending).resolves.toBe(true);
  });

  it("keeps waiting when the policy opens after the app leaves the foreground", async () => {
    let resolveOpen: (() => void) | undefined;
    native.openURL.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const pending = promptAiConsent(recipient, "https://example.com/privacy");
    const first = currentAlert();

    first.buttons[1]?.onPress?.();
    native.emit("inactive");
    resolveOpen?.();
    await flushTimers();
    await flushTimers();

    expect(native.alert).toHaveBeenCalledTimes(1);
    native.emit("active");
    await flushTimers();

    expect(native.alert).toHaveBeenCalledTimes(2);
    currentAlert().buttons[2]?.onPress?.();
    await expect(pending).resolves.toBe(true);
  });

  it("reopens the choice when the policy cannot be opened without granting permission", async () => {
    native.openURL.mockRejectedValueOnce(new Error("No browser"));
    const pending = promptAiConsent(recipient, "https://example.com/privacy");
    const first = currentAlert();

    first.buttons[1]?.onPress?.();
    first.options.onDismiss?.();
    await flushTimers();
    await flushTimers();

    expect(native.alert).toHaveBeenCalledTimes(2);
    const second = currentAlert();
    second.buttons[0]?.onPress?.();
    await expect(pending).resolves.toBe(false);
    expect(native.alert).toHaveBeenCalledTimes(2);
  });
});
