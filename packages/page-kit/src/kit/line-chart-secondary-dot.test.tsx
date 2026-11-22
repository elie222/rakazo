import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LineChart } from "./charts.js";

const points = [
  { label: "Jan", value: 5 },
  { label: "Feb", value: 8 },
  { label: "Mar", value: 6 },
  { label: "Apr", value: 9 },
];

function render(values: number[], primary = points) {
  return renderToStaticMarkup(
    <LineChart points={primary} secondary={{ label: "Target", values }} />,
  );
}

function comparisonPath(markup: string) {
  return markup.match(/class="rk-line-secondary" d="([^"]*)"/)?.[1];
}

function comparisonDots(markup: string) {
  const comparison = markup.match(/<g style="--rk-series:var\(--rk-other\)">([\s\S]*?)<\/g>/)?.[1];
  return comparison?.match(/<circle class="rk-line-dot" [^>]*r="3\.5"/g) ?? [];
}

describe("LineChart comparison dots", () => {
  it.each([
    { name: "with a primary line", base: points },
    { name: "without a primary line", base: [] },
  ])("marks a lone comparison value $name", ({ base }) => {
    const markup = render([7], base);
    expect(comparisonPath(markup)).toMatch(/^M[^L]+$/);
    expect(comparisonDots(markup)).toHaveLength(1);
  });

  it("marks isolated finite values without drawing across gaps", () => {
    const markup = render([0, Number.NaN, 2, 3, Number.POSITIVE_INFINITY, -1]);
    expect(comparisonPath(markup)?.match(/[ML]/g)).toEqual(["M", "M", "L", "M"]);
    expect(comparisonDots(markup)).toHaveLength(2);
  });

  it("keeps continuous comparisons dashed, and keeps primary-only markers", () => {
    const continuous = render([1, 2, 3]);
    expect(comparisonPath(continuous)?.match(/[ML]/g)).toEqual(["M", "L", "L"]);
    expect(comparisonDots(continuous)).toHaveLength(0);
    const primaryOnly = renderToStaticMarkup(<LineChart points={[{ value: 5 }]} />);
    expect(comparisonPath(primaryOnly)).toBeUndefined();
    expect(primaryOnly).toContain('<circle class="rk-line-dot"');
  });
});
