import { describe, expect, it, vi } from "vitest";
import { recordToolConnected } from "./tool-connect-analytics.js";

describe("recordToolConnected", () => {
  const createdAt = new Date("2026-08-26T00:00:00.000Z");

  it("names only apps from the fixed catalog", () => {
    const analytics = { capture: vi.fn(), flush: vi.fn() };

    recordToolConnected(analytics, "user-1", {
      id: "conn-1",
      provider: "googlecalendar",
      createdAt,
    });
    recordToolConnected(analytics, "user-1", { id: "conn-2", provider: "acme_crm", createdAt });

    expect(analytics.capture.mock.calls).toEqual([
      [
        "user-1",
        { name: "tool_connected", app: "google-calendar" },
        { id: "conn-1", at: createdAt },
      ],
      ["user-1", { name: "tool_connected" }, { id: "conn-2", at: createdAt }],
    ]);
  });
});
