import { describe, expect, it, vi } from "vitest";
import { isForegroundState } from "./app-foreground";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: vi.fn() },
}));

describe("isForegroundState", () => {
  it("keeps live work running unless the app is backgrounded", () => {
    expect(isForegroundState("active")).toBe(true);
    expect(isForegroundState("inactive")).toBe(true);
    expect(isForegroundState(null)).toBe(true);
    expect(isForegroundState("background")).toBe(false);
  });
});
