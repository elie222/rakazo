import { expect, it, vi } from "vitest";

const alert = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({ Alert: { alert } }));
vi.mock("./i18n", () => ({ t: (value: string) => value }));

import { showRunExecutionProfile } from "./run-execution-profile";

it("shows immutable run attribution using safe labels only", () => {
  showRunExecutionProfile({
    id: "private-id",
    name: "Review",
    revision: 2,
    harness: "claude",
    provider: "gateway",
    modelId: "review-model",
    accountLabel: "Archived project account",
  });
  expect(alert).toHaveBeenCalledWith(
    "Run details",
    "Execution profile: Review · v2\nHarness: Claude Agent\nProvider: gateway\nModel: review-model\nAccount: Archived project account",
  );
  expect(alert.mock.lastCall?.join()).not.toContain("private-id");
});
