import { describe, expect, it } from "vitest";
import type { FlowEvidence } from "./flow.js";
import { isMondayMorningCron, weeklyShopping } from "./weekly-shopping.js";

type World = Parameters<typeof weeklyShopping.grade>[0]["world"];

const store: World["store"] = {
  credentials: { email: "shopper@example.test", password: "fresh-fig-12" },
  outOfStock: ["oat-milk", "cheddar-200"],
  pendingCode: null,
  logins: 1,
  failedLogins: 0,
  slots: [
    { id: "slot-1", label: "Mon 26 Oct, 9–11 am", full: true },
    { id: "slot-2", label: "Mon 26 Oct, 6–8 pm", full: false },
    { id: "slot-3", label: "Tue 27 Oct, 9–11 am", full: false },
    { id: "slot-4", label: "Tue 27 Oct, 6–8 pm", full: false },
    { id: "slot-5", label: "Wed 28 Oct, 12–2 pm", full: false },
  ],
  orders: [],
};
const expected = {
  "whole-milk-2l": 1,
  "eggs-12": 1,
  sourdough: 1,
  bananas: 1,
  "coffee-beans": 1,
  "almond-milk": 2,
  "greek-yogurt": 2,
};
const order = (slotId: string) => ({
  id: "FC-1042",
  items: Object.entries(expected).map(([sku, qty]) => ({
    sku,
    name: sku,
    size: "",
    qty,
    unitPrice: 100,
  })),
  slot: { id: slotId, label: store.slots.find((slot) => slot.id === slotId)!.label },
  total: 1000,
});

function evidence(slotId: string, cron: string): FlowEvidence<World> {
  const placed = { ...store, orders: [order(slotId)] };
  return {
    world: { seed: 1, adminToken: "token", store, expected },
    transcript: [],
    routines: [{ name: "Groceries", prompt: "Order the list", crons: [cron], active: true }],
    toolNames: [],
    observations: { conversation: placed, "wake-1": placed },
    endedBy: "user-done",
  };
}
const failing = (e: FlowEvidence<World>) =>
  weeklyShopping
    .grade(e)
    .filter((criterion) => !criterion.pass)
    .map((criterion) => criterion.id);

describe("weekly shopping grading", () => {
  it("accepts only one Monday-morning run a week", () => {
    expect(isMondayMorningCron("0 7 * * 1")).toBe(true);
    expect(isMondayMorningCron("30 6 * * MON")).toBe(true);
    expect(isMondayMorningCron("0 9 * * 1-5")).toBe(false);
    expect(isMondayMorningCron("0 9 * * 2")).toBe(false);
    expect(isMondayMorningCron("0 18 * * 1")).toBe(false);
    expect(isMondayMorningCron("0 7 1 * 1")).toBe(false);
    expect(isMondayMorningCron("0 7,19 * * 1")).toBe(false);
  });

  it("passes the right cart in the earliest open morning slot", () => {
    expect(failing(evidence("slot-3", "0 7 * * 1"))).toEqual([]);
  });

  it("fails a later or evening slot and a wrong schedule", () => {
    expect(failing(evidence("slot-2", "0 7 * * 1"))).toEqual(["first-week-earliest-morning-slot"]);
    expect(failing(evidence("slot-3", "0 9 * * 1-5"))).toEqual(["weekly-routine"]);
  });
});
