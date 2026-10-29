// @vitest-environment jsdom

import { botEyeColor } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupSeats } from "../components/group-seats";

type Props = Record<string, unknown> & { children?: ReactNode; style?: unknown };

vi.mock("react-native", () => ({
  View: ({ children, style }: Props) =>
    createElement("div", { "data-style": JSON.stringify(style) }, children),
}));
// Each drawing primitive renders as an element of its own name, with its props as attributes.
vi.mock("react-native-svg", () => {
  const element =
    (name: string) =>
    ({ children, ...props }: Props) =>
      createElement(
        `svg-${name.toLowerCase()}`,
        Object.fromEntries(
          Object.entries(props).map(([key, value]) => [
            `data-${key.toLowerCase()}`,
            typeof value === "object" ? JSON.stringify(value) : String(value),
          ]),
        ),
        children,
      );
  return {
    default: element("Svg"),
    Circle: element("Circle"),
    ClipPath: element("ClipPath"),
    Defs: element("Defs"),
    Ellipse: element("Ellipse"),
    G: element("G"),
    Image: element("Image"),
    Mask: element("Mask"),
    Path: element("Path"),
    Rect: element("Rect"),
    Text: element("Text"),
  };
});
vi.mock("../lib/native", () => ({
  native: { systemTertiaryLabel: "tertiary", fill: "fill" },
  useResolvedAppearance: () => "light",
}));

const member = (index: number) => ({
  botId: `bot-${index}`,
  name: `Bot ${index}`,
  color: `#3B82F6::shape_${index % 8}`,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

function render(count: number) {
  act(() =>
    root.render(<GroupSeats members={Array.from({ length: count }, (_, i) => member(i))} />),
  );
  const svg = container.querySelector("svg-svg")!;
  // The seats are the top-level groups; each but the last is cut by the one after it.
  const seats = Array.from(svg.children).filter((node) => node.tagName === "SVG-G");
  return { svg, seats, masks: svg.querySelectorAll("svg-mask") };
}

describe("GroupSeats", () => {
  it("draws every member of a small group, each cut by the next", () => {
    const { svg, seats, masks } = render(3);
    expect(svg.getAttribute("data-width")).toBe("63");
    expect(seats).toHaveLength(3);
    expect(masks).toHaveLength(2);
    expect(seats.map((seat) => seat.getAttribute("data-mask"))).toEqual([
      expect.stringMatching(/carve-0\)$/),
      expect.stringMatching(/carve-1\)$/),
      "undefined",
    ]);
    expect(svg.querySelector("svg-text")).toBeNull();
  });

  it("draws three members and a +N in tertiary ink that also cuts the seat under it", () => {
    const { svg, seats, masks } = render(8);
    expect(svg.getAttribute("data-width")).toBe("80.5");
    expect(seats).toHaveLength(4);
    const labels = Array.from(svg.querySelectorAll("svg-text"));
    expect(labels.map((label) => label.textContent)).toEqual(["+5", "+5"]);
    // One label is the seat itself, the other the cut it makes in the seat before it.
    expect(labels.map((label) => label.getAttribute("data-fill")).sort()).toEqual([
      "black",
      "tertiary",
    ]);
    // 21 pt semibold, centred in the 28 pt seat.
    expect(labels[0]!.getAttribute("data-fontsize")).toBe("21");
    expect(labels[0]!.getAttribute("data-fontweight")).toBe("600");
    expect(masks).toHaveLength(3);
    expect(masks[2]!.querySelector("svg-text")).not.toBeNull();
  });

  it("follows a lone member with the group's mark in tertiary ink, which cuts the face", () => {
    const { svg, seats, masks } = render(1);
    expect(svg.getAttribute("data-width")).toBe("45.5");
    expect(seats).toHaveLength(2);
    expect(masks).toHaveLength(1);
    expect(masks[0]!.querySelector("svg-path")).not.toBeNull();
    const mark = seats[1]!.querySelector("svg-path")!;
    expect(mark.getAttribute("data-stroke")).toBe("tertiary");
    expect(svg.querySelector("svg-text")).toBeNull();
  });

  it("draws only the group's mark for a group with no members left", () => {
    const { svg, seats, masks } = render(0);
    expect(svg.getAttribute("data-width")).toBe("28");
    expect(seats).toHaveLength(1);
    expect(masks).toHaveLength(0);
    expect(seats[0]!.querySelector("svg-path")!.getAttribute("data-stroke")).toBe("tertiary");
  });

  it("gives a drawn face the same eye ink as the bot's own avatar", () => {
    act(() =>
      root.render(
        <GroupSeats
          members={[
            { botId: "bot-a", name: "A", color: "#3EC5A8" },
            { botId: "bot-b", name: "B", color: "#F5A03C" },
          ]}
        />,
      ),
    );
    const eyes = Array.from(container.querySelectorAll("svg-g[data-fill]"), (group) =>
      group.getAttribute("data-fill"),
    );
    expect(eyes).toEqual([botEyeColor, botEyeColor]);
  });
});
