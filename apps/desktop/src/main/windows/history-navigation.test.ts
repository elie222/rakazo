import { describe, expect, it } from "vitest";
import { historyTarget } from "./history-navigation.js";

const app = "https://app.example.test";
const history = {
  urls: [`${app}/`, `${app}/bots/1`, `${app}/bots/2`],
  activeIndex: 1,
};

describe("historyTarget", () => {
  it.each([
    ["left", 0],
    ["browser-backward", 0],
    ["right", 2],
    ["browser-forward", 2],
    ["up", null],
  ])("maps %s to entry %s", (gesture, index) => {
    expect(historyTarget(gesture, history, app)).toBe(index);
  });

  it("stops at the window's first page", () => {
    expect(historyTarget("left", { ...history, activeIndex: 0 }, app)).toBeNull();
    expect(historyTarget("right", { ...history, activeIndex: 2 }, app)).toBeNull();
  });

  it("never steps onto another origin's page", () => {
    const mixed = { urls: ["https://other.example.test/", `${app}/`], activeIndex: 1 };
    expect(historyTarget("left", mixed, app)).toBeNull();
    expect(
      historyTarget("left", { urls: ["data:text/html,", `${app}/`], activeIndex: 1 }, null),
    ).toBeNull();
  });
});
