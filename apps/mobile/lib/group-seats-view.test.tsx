// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupSeats } from "../components/group-seats";
import { groupTitleSeats } from "./group-seats";

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
  useMobileTokens: () => ({ background: "#FFFFFF", foreground: "#141414" }),
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
  const { seats: placed } = groupTitleSeats(Array.from({ length: count }, (_, i) => member(i)));
  act(() => root.render(<GroupSeats seats={placed} />));
  const svg = container.querySelector("svg-svg")!;
  // The seats are the top-level groups; each but the first tucks under the one before it.
  const seats = Array.from(svg.children).filter((node) => node.tagName === "SVG-G");
  return { svg, seats, masks: svg.querySelectorAll("svg-mask") };
}

describe("GroupSeats", () => {
  it("puts the first member on top, each after it cut by the one before", () => {
    const { svg, seats, masks } = render(3);
    expect(svg.getAttribute("data-width")).toBe("78");
    expect(seats).toHaveLength(3);
    expect(masks).toHaveLength(2);
    expect(seats.map((seat) => seat.getAttribute("data-mask"))).toEqual([
      "undefined",
      expect.stringMatching(/carve-1\)$/),
      expect.stringMatching(/carve-2\)$/),
    ]);
  });

  it("draws only three faces for a bigger group; the count is the title's text, not a seat", () => {
    const { svg, seats } = render(8);
    expect(svg.getAttribute("data-width")).toBe("78");
    expect(seats).toHaveLength(3);
    expect(svg.querySelector("svg-text")).toBeNull();
  });

  it("follows a lone member with the group's mark in tertiary ink, cut by the face", () => {
    const { svg, seats, masks } = render(1);
    expect(svg.getAttribute("data-width")).toBe("56");
    expect(seats).toHaveLength(2);
    expect(masks).toHaveLength(1);
    const mark = seats[1]!.querySelector("svg-path")!;
    expect(mark.getAttribute("data-stroke")).toBe("tertiary");
  });

  it("draws only the group's mark for a group with no members left", () => {
    const { svg, seats, masks } = render(0);
    expect(svg.getAttribute("data-width")).toBe("34");
    expect(seats).toHaveLength(1);
    expect(masks).toHaveLength(0);
    expect(seats[0]!.querySelector("svg-path")!.getAttribute("data-stroke")).toBe("tertiary");
  });

  it("gives a drawn face the same eye ink as the bot's own avatar", () => {
    act(() =>
      root.render(
        <GroupSeats
          seats={
            groupTitleSeats([
              { botId: "bot-a", name: "A", color: "#3EC5A8" },
              { botId: "bot-b", name: "B", color: "#F5A03C" },
            ]).seats
          }
        />,
      ),
    );
    const eyes = Array.from(container.querySelectorAll("svg-g[data-fill]"), (group) =>
      group.getAttribute("data-fill"),
    );
    // Both bodies are pale, so their eyes stay dark on a light page, as on the bot's own avatar.
    expect(eyes).toEqual(["#141414", "#141414"]);
  });
});
