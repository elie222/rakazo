import { Alert } from "react-native";
import { beforeEach, expect, it, vi } from "vitest";
import { hasUnsentSends } from "./thread-feedback";
import { confirmUnsentSendLoss } from "./unsent-send-warning";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("./thread-feedback", () => ({ hasUnsentSends: vi.fn() }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasUnsentSends).mockReturnValue(false);
});

it("proceeds without a prompt when no unsent messages wait", async () => {
  await expect(confirmUnsentSendLoss("sign-out")).resolves.toBe(true);
  expect(Alert.alert).not.toHaveBeenCalled();
});

it.each([
  ["sign-out", "Signing out deletes unsent messages.", "Sign out anyway"] as const,
  ["server-switch", "Switching servers deletes unsent messages.", "Switch anyway"] as const,
])(
  "asks before %s clears the queue and follows the chosen button",
  async (kind, message, confirm) => {
    vi.mocked(hasUnsentSends).mockReturnValue(true);
    const pending = confirmUnsentSendLoss(kind);
    const [title, body, buttons] = vi.mocked(Alert.alert).mock.calls[0]!;
    const confirmButtons = buttons!;
    expect(title).toBe("Unsent messages");
    expect(body).toBe(message);
    expect(confirmButtons[0]!.text).toBe("Cancel");
    expect(confirmButtons[0]!.style).toBe("cancel");
    expect(confirmButtons[1]!.text).toBe(confirm);
    expect(confirmButtons[1]!.style).toBe("destructive");

    confirmButtons[0]!.onPress?.();
    await expect(pending).resolves.toBe(false);

    const confirmed = confirmUnsentSendLoss(kind);
    vi.mocked(Alert.alert).mock.calls[1]![2]![1]!.onPress?.();
    await expect(confirmed).resolves.toBe(true);
  },
);
