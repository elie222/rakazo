import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Scatter } from "./scatter.js";

const axes = { x: { floor: 0, ceiling: 4 }, y: { floor: 0, ceiling: 10 } };

function trendLine(svg: string) {
  return (
    svg
      .match(/<line class="rk-trend" x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/)
      ?.slice(1)
      .map(Number) ?? null
  );
}

function throughDots(svg: string, first: number, last: number) {
  const dots = Array.from(
    svg.matchAll(/<circle class="rk-dot" cx="([^"]+)" cy="([^"]+)"/g),
    (dot) => dot.slice(1).map(Number),
  );
  return [...dots[first]!, ...dots[last]!];
}

describe("Scatter trend line", () => {
  it("clips a horizontal fit to both ends of the visible x range without removing dots", () => {
    const points = [-2, 0, 4, 8].map((x) => ({ x, y: 3 }));
    const svg = renderToStaticMarkup(<Scatter {...axes} points={points} trend />);
    expect(svg.match(/class="rk-dot"/g)).toHaveLength(points.length);
    expect(trendLine(svg)).toEqual(throughDots(svg, 1, 2));
  });

  it.each([
    {
      name: "a horizontal fit above the y range",
      points: [
        { x: 1, y: 15 },
        { x: 3, y: 15 },
      ],
    },
    {
      name: "a sloping fit above the y range",
      points: [
        { x: 1, y: 12 },
        { x: 3, y: 14 },
      ],
    },
    {
      name: "a fit to the right of the x range",
      points: [
        { x: 5, y: 3 },
        { x: 7, y: 3 },
      ],
    },
  ])("omits $name", ({ points }) => {
    const svg = renderToStaticMarkup(<Scatter {...axes} points={points} trend />);
    expect(trendLine(svg)).toBeNull();
  });

  it.each([5, -5])("clips a slope of %d at the visible y bounds", (slope) => {
    const points = [-1, 1, 3, 5].map((x) => ({ x, y: 5 + slope * (x - 2) }));
    const svg = renderToStaticMarkup(<Scatter {...axes} points={points} trend />);
    expect(trendLine(svg)).toEqual(throughDots(svg, 1, 2));
  });

  it("keeps the fit within the observed x values on automatic axes", () => {
    const points = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 6, y: 7 },
    ];
    const svg = renderToStaticMarkup(<Scatter points={points} trend />);
    const [x1, , x2] = trendLine(svg)!;
    const [first, , last] = throughDots(svg, 0, 2);
    expect([x1, x2]).toEqual([first, last]);
  });
});
