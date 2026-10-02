import { describe, expect, it, vi } from "vitest";
import { rosterWorkStatusLabel } from "./roster-status";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
}));

describe("rosterWorkStatusLabel", () => {
  it("names queued, leased, and running work for the sidebar", () => {
    expect(rosterWorkStatusLabel("queued")).toBe("Waiting in line…");
    expect(rosterWorkStatusLabel("leased")).toBe("Starting…");
    expect(rosterWorkStatusLabel("running")).toBe("Working…");
  });

  it("leaves other statuses to the message preview", () => {
    expect(rosterWorkStatusLabel("idle")).toBeNull();
    expect(rosterWorkStatusLabel("waiting_input")).toBeNull();
    expect(rosterWorkStatusLabel("waiting_takeover")).toBeNull();
    expect(rosterWorkStatusLabel("completed")).toBeNull();
    expect(rosterWorkStatusLabel("failed")).toBeNull();
    expect(rosterWorkStatusLabel("cancelled")).toBeNull();
    expect(rosterWorkStatusLabel("")).toBeNull();
  });
});
