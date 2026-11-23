// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Columns } from "./columns.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const unmount of cleanup.splice(0)) unmount();
  vi.unstubAllGlobals();
});

function mount(width: number, count: number) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // JSDOM cannot lay out the chart; report its measured width directly.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private report: (entries: unknown[]) => void) {}
      observe() {
        this.report([{ contentRect: { width } }]);
      }
      disconnect() {}
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const points = Array.from({ length: count }, (_, i) => ({ label: "W" + (i + 1), value: i + 1 }));
  act(() => root.render(<Columns points={points} />));
  const svg = host.querySelector("svg")!;
  expect(svg.getAttribute("width")).toBe(String(width));
  const bounds = [...svg.querySelectorAll(".rk-column")].map((path) => {
    // The top edge runs from M(left + radius) to H(right - radius), then arcs to the right edge.
    const [start, , end, radius] = path
      .getAttribute("d")!
      .match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!
      .map(Number);
    return { left: start! - radius!, right: end! + radius! };
  });
  return {
    bounds,
    hover: (x: number) =>
      act(() => svg.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x }))),
    key: (key: string) =>
      act(() => svg.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }))),
    tip: () => host.querySelector(".rk-tip-title")?.textContent,
  };
}

it.each([300, 43])("keeps all 52 columns and their hit targets inside a %dpx plot", (width) => {
  const chart = mount(width, 52);
  expect(chart.bounds).toHaveLength(52);
  for (const [i, { left, right }] of chart.bounds.entries()) {
    expect(right).toBeGreaterThan(left);
    expect(left).toBeGreaterThanOrEqual((chart.bounds[i - 1]?.right ?? 0) - 1e-6);
    expect(right).toBeLessThanOrEqual(width + 1e-6);
  }
  for (const i of [0, 25, 51]) {
    const { left, right } = chart.bounds[i]!;
    chart.hover((left + right) / 2);
    expect(chart.tip()).toBe("W" + (i + 1));
  }
  chart.key("Home");
  expect(chart.tip()).toBe("W1");
  chart.key("End");
  expect(chart.tip()).toBe("W52");
  chart.key("ArrowLeft");
  expect(chart.tip()).toBe("W51");
  chart.key("Escape");
  expect(chart.tip()).toBeUndefined();
});

it("preserves the 8px slots and normal bar width for 12 columns in 300px", () => {
  const { bounds } = mount(300, 12);
  const slot = (300 - 8 * 11) / 12;
  bounds.forEach(({ left, right }, i) => {
    expect(right - left).toBeCloseTo(slot * 0.7, 8);
    expect((left + right) / 2).toBeCloseTo(i * (slot + 8) + slot / 2, 8);
  });
});
