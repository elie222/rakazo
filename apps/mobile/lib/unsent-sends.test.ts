import { MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import { router } from "expo-router";
import { Alert } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SendAttempt } from "./thread-feedback";
import { configureUnsentSends } from "./thread-feedback";
import "./unsent-sends";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() }, AppState: {} }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("./api", () => ({ isServerReachable: vi.fn() }));
vi.mock("./artifact-cache-session", () => ({}));
vi.mock("./integrations-cache", () => ({}));
vi.mock("./outbox-disk", () => ({ outboxDisk: {} }));
vi.mock("./session", () => ({}));
vi.mock("./thread-feedback", () => ({ configureUnsentSends: vi.fn() }));
vi.mock("./i18n", () => ({ t: (message: string) => `translated: ${message}` }));

const { notDelivered } = vi.mocked(configureUnsentSends).mock.calls[0]![0];
function attempt(error: string): SendAttempt {
  return { error } as SendAttempt;
}
beforeEach(() => vi.clearAllMocks());
describe("notDelivered", () => {
  it("leaves image confirmation to the contextual choices without a generic modal", () => {
    notDelivered({
      ...attempt("Image input is not configured for this model."),
      imageConfirmation: true,
    });
    expect(Alert.alert).not.toHaveBeenCalled();
  });
  it("offers Models settings and cancellation for the missing-model rejection", () => {
    notDelivered(attempt(` ${MODEL_REQUIRED_SEND_ERROR} `));
    const [title, message, buttons] = vi.mocked(Alert.alert).mock.calls[0]!;
    expect(title).toBe("translated: Add an AI model to keep chatting");
    expect(message).toBeUndefined();
    expect(buttons).toEqual([
      { text: "translated: Not Now", style: "cancel" },
      { text: "translated: Add Model", onPress: expect.any(Function), isPreferred: true },
    ]);
    expect(router.push).not.toHaveBeenCalled();
    buttons![1]!.onPress!();
    expect(router.push).toHaveBeenCalledWith("/(settings)/models");
  });
  it("keeps the existing alert for unrelated errors", () => {
    notDelivered(attempt("Rejected"));
    expect(Alert.alert).toHaveBeenCalledWith("translated: Failed to send message", "Rejected");
    expect(router.push).not.toHaveBeenCalled();
  });
});
