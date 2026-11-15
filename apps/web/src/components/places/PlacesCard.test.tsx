// @vitest-environment jsdom

import type { PlacesCard as PlacesCardData } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlacesCard } from "./PlacesCard";

// The Lingui macro compiles a template into a message with named values; fill them in.
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (
      source: TemplateStringsArray | { message: string; values?: Record<string, unknown> },
      ...values: unknown[]
    ) =>
      "message" in source
        ? source.message.replace(/\{(\w+)\}/g, (_, key) => String(source.values?.[key]))
        : String.raw({ raw: source }, ...values),
    i18n: { locale: "en" },
  }),
}));

function card(overrides: Partial<PlacesCardData> = {}): PlacesCardData {
  return {
    query: "pharmacy",
    centre: { latitude: 38.7139, longitude: -9.1394 },
    places: [
      {
        id: "a",
        name: "Farmácia Estácio",
        category: "Pharmacy",
        address: "Praça Dom Pedro IV 12",
        latitude: 38.7149,
        longitude: -9.1399,
        distanceM: 120,
        hours: "Mo-Fr 09:00-20:00",
      },
      { id: "b", name: "Farmácia Normal", latitude: 38.7112, longitude: -9.1368 },
    ],
    map: { tileUrl: "https://example.test/tiles/{z}/{x}/{y}.png", attribution: "Map data" },
    attribution: { name: "© OpenStreetMap contributors", url: "https://example.test/copyright" },
    ...overrides,
  };
}

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => root.unmount());
  host.remove();
});

function render(data: PlacesCardData) {
  act(() => root.render(<PlacesCard card={data} />));
}

it("lists each place with category, distance, address and hours", () => {
  vi.spyOn(navigator, "language", "get").mockReturnValue("pt-PT");
  render(card());
  const rows = host.querySelectorAll("li");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("Farmácia Estácio");
  expect(rows[0]?.textContent).toContain("Pharmacy · 120 m");
  expect(rows[0]?.textContent).toContain("Praça Dom Pedro IV 12");
  expect(rows[0]?.querySelector("[title='Mo-Fr 09:00-20:00']")).not.toBeNull();
  expect(rows[1]?.textContent).not.toContain("·");
});

it("links each row to a maps page in a new tab", () => {
  render(card());
  const link = host.querySelector("li a") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toContain("openstreetmap.org");
  expect(link.target).toBe("_blank");
  expect(link.rel).toBe("noopener noreferrer");
  expect(link.title).toBe("Open in Maps");
});

it("draws a numbered pin per place, the count chip and the tile credit", () => {
  render(card());
  const map = host.querySelector("[aria-label='Places on a map']") as HTMLElement;
  expect(map.getAttribute("dir")).toBe("ltr");
  expect([...map.querySelectorAll("[data-pin]")].map((pin) => pin.textContent)).toEqual(["1", "2"]);
  expect(map.textContent).toContain("2 places");
  expect(map.textContent).toContain("Map data");
  const tile = map.querySelector("img") as HTMLImageElement;
  expect(tile.getAttribute("src")).toMatch(/^https:\/\/example\.test\/tiles\/\d+\/\d+\/\d+\.png$/);
  expect(tile.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
});

it("hides a tile that fails to load", () => {
  render(card());
  const tiles = [...host.querySelectorAll("img")];
  expect(tiles.length).toBeGreaterThan(0);
  act(() => {
    for (const tile of tiles) tile.dispatchEvent(new Event("error"));
  });
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelectorAll("[data-pin]")).toHaveLength(2);
});

it("shows only the list when the card has no map", () => {
  render(card({ map: undefined }));
  expect(host.querySelector("[aria-label='Places on a map']")).toBeNull();
  expect(host.querySelectorAll("li")).toHaveLength(2);
});

it("highlights a pin while its row is hovered", () => {
  render(card());
  const row = host.querySelector("li") as HTMLElement;
  act(() => {
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  expect(host.querySelector("[data-pin='1']")?.hasAttribute("data-selected")).toBe(true);
  expect(host.querySelector("[data-pin='2']")?.hasAttribute("data-selected")).toBe(false);
});

it("links the data credit only over https", () => {
  render(card());
  const credit = host.querySelector("a[href='https://example.test/copyright']");
  expect(credit?.textContent).toBe("© OpenStreetMap contributors");
});

function crowded(): PlacesCardData {
  const at = (id: string, latitude: number, longitude: number) => ({
    id,
    name: `Place ${id}`,
    latitude,
    longitude,
  });
  return card({
    places: [
      at("1", 38.7, -9.1),
      at("2", 38.70001, -9.10001),
      at("3", 38.70002, -9.10002),
      at("4", 38.76, -9.2),
      at("5", 38.66, -9.0),
      at("6", 38.8, -9.3),
      at("7", 38.6, -8.9),
    ],
  });
}

it("draws pins for the visible rows only and groups pins that would overlap", () => {
  render(crowded());
  expect(host.querySelectorAll("li")).toHaveLength(5);
  // Rows 1 to 3 share a spot: one counted group, then pins 4 and 5.
  expect(host.querySelector("[data-group]")?.textContent).toBe("3");
  expect([...host.querySelectorAll("[data-pin]")].map((pin) => pin.textContent)).toEqual([
    "4",
    "5",
  ]);
});

it("shows every row and its pins after Show more", () => {
  render(crowded());
  const more = [...host.querySelectorAll("button")].find((b) => b.textContent === "Show more");
  act(() => more?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(host.querySelectorAll("li")).toHaveLength(7);
  expect([...host.querySelectorAll("[data-pin]")].map((pin) => pin.textContent)).toEqual([
    "4",
    "5",
    "6",
    "7",
  ]);
});

it("opens the whole list from a group that cannot be pulled apart", () => {
  render(crowded());
  const tap = () =>
    act(() =>
      host.querySelector("[data-group]")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
  // The first tap zooms in as far as the map goes; the places still overlap there, so the next
  // tap opens the whole list.
  tap();
  expect(host.querySelectorAll("li")).toHaveLength(5);
  tap();
  expect(host.querySelectorAll("li")).toHaveLength(7);
});
