import { beforeEach, describe, expect, it, vi } from "vitest";

const alert = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({ Alert: { alert } }));

import { i18n } from "@lingui/core";
import { generateMessageId } from "@lingui/message-utils/generateMessageId";
import type { AiRecipient } from "@rakazo/contracts";
import { resetI18nForTests } from "../i18n/i18n";
import { promptAiConsent } from "./ai-consent";

/** A catalog message in the active language, looked up as the compiled macro does. */
function t(message: string, values?: Record<string, string>) {
  return i18n._({ id: generateMessageId(message), message, values });
}

type AlertButton = { text?: string; onPress?: () => void };
type AlertOptions = { onDismiss?: () => void };

const recipient: AiRecipient = {
  key: "provider",
  name: "Example AI",
  use: "model",
  detail: "Forwards to model providers",
  allowed: false,
};

function currentAlert() {
  const call = alert.mock.calls.at(-1);
  if (!call) throw new Error("Expected an AI consent alert");
  return {
    title: call[0] as string,
    message: call[1] as string,
    buttons: (call[2] ?? []) as AlertButton[],
    options: (call[3] ?? {}) as AlertOptions,
  };
}

describe("mobile AI consent prompt", () => {
  beforeEach(() => {
    resetI18nForTests();
    alert.mockReset();
  });

  it("asks in one short line with two choices", async () => {
    const pending = promptAiConsent(recipient);
    const shown = currentAlert();
    expect(shown.title).toBe(t("Send data to {name}?", { name: recipient.name }));
    expect(shown.message).toBe(
      t(
        "Messages, files, bot instructions, memories and connected-app content are sent to run your bots.",
      ),
    );
    expect(shown.buttons.map((button) => button.text)).toEqual([t("Not now"), t("Allow")]);
    shown.buttons[1]?.onPress?.();
    await expect(pending).resolves.toBe(true);
  });

  it("settles a refusal once when Android also dismisses the alert", async () => {
    const pending = promptAiConsent(recipient);
    const shown = currentAlert();
    shown.buttons[0]?.onPress?.();
    shown.options.onDismiss?.();
    await expect(pending).resolves.toBe(false);
    expect(alert).toHaveBeenCalledOnce();
  });

  it("treats dismissing without a choice as a refusal", async () => {
    const pending = promptAiConsent(recipient);
    currentAlert().options.onDismiss?.();
    await expect(pending).resolves.toBe(false);
  });
});
