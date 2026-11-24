// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Checklist } from "./data.js";
import { startPageState, usePageState } from "./page-state.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let posted: unknown[];
beforeEach(() => {
  vi.useFakeTimers();
  host = document.body.appendChild(document.createElement("div"));
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message);
  });
});
afterEach(() => {
  vi.runAllTimers();
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const setters = new Map<string, (value: unknown) => void>();
function Field({ name, initial }: { name: string; initial: unknown }) {
  const [value, setValue] = usePageState(name, initial);
  setters.set(name, setValue as (value: unknown) => void);
  return <output data-key={name}>{JSON.stringify(value)}</output>;
}
function render(fields: Array<[string, unknown]>) {
  const root = createRoot(host);
  act(() =>
    root.render(
      fields.map(([name, initial]) => <Field key={name} name={name} initial={initial} />),
    ),
  );
}
const shown = (name: string) => host.querySelector(`[data-key="${name}"]`)?.textContent;
const set = (name: string, value: unknown) => act(() => setters.get(name)?.(value));
const fromHost = (values: Record<string, unknown>) =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "rakazo-page:state", values } }),
    );
  });

describe("usePageState", () => {
  it("keeps a value in memory and sends nothing where the host does not save", () => {
    render([["unsaved", "start"]]);
    set("unsaved", "typed");
    vi.advanceTimersByTime(1000);
    expect(shown("unsaved")).toBe('"typed"');
    expect(posted).toEqual([]);
  });

  it("starts from saved values that keep the page's shape, and the page's own otherwise", () => {
    startPageState({ note: "Charger", count: "three" });
    render([
      ["note", ""],
      ["count", 0],
    ]);
    expect(shown("note")).toBe('"Charger"');
    expect(shown("count")).toBe("0");
  });

  it("sends a change at once, the burst after it as one save, and keeps unsavable keys in memory", () => {
    render([
      ["note", ""],
      ["ticks", {}],
      ["bad key", false],
    ]);
    set("note", "Adapter");
    expect(posted).toEqual([{ type: "rakazo-page:state", values: { note: "Adapter" } }]);
    set("note", "Adapter for EU");
    set("ticks", { passport: true });
    set("bad key", true);
    expect(posted).toHaveLength(1);
    vi.advanceTimersByTime(400);
    expect(posted[1]).toEqual({
      type: "rakazo-page:state",
      values: { note: "Adapter for EU", ticks: { passport: true } },
    });
    expect(shown("bad key")).toBe("true");
  });

  it("sends a burst of more values than one save takes in several saves", () => {
    const names = Array.from({ length: 150 }, (_, index) => `many${index}`);
    render(names.map((name) => [name, 0] as [string, unknown]));
    for (const name of names) set(name, 1);
    vi.advanceTimersByTime(400);
    const sent = posted.map(
      (message) => Object.keys((message as { values: object }).values).length,
    );
    expect(sent).toEqual([1, 100, 49]);
  });

  it("lets the reader tick a saved Checklist, starting each item where the page put it", () => {
    act(() =>
      createRoot(host).render(
        <Checklist
          saveAs="packing"
          items={[
            { text: "Passport", done: true },
            { text: "Charger", id: "charger" },
            { text: "Passport" },
          ]}
        />,
      ),
    );
    const boxes = host.querySelectorAll<HTMLInputElement>("input");
    expect([...boxes].map((box) => [box.checked, box.disabled])).toEqual([
      [true, false],
      [false, false],
      [false, false],
    ]);
    act(() => boxes[1]!.click());
    expect(posted).toEqual([{ type: "rakazo-page:state", values: { packing: { charger: true } } }]);
    act(() => boxes[0]!.click());
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(posted[1]).toEqual({
      type: "rakazo-page:state",
      values: { packing: { charger: true, Passport: false } },
    });
  });

  it("takes another copy's values, holding the latest one over a fresh change until it settles", () => {
    render([
      ["note", ""],
      ["other", ""],
    ]);
    set("note", "Mine");
    fromHost({ note: "Older read", other: "From my phone" });
    expect(shown("note")).toBe('"Mine"');
    expect(shown("other")).toBe('"From my phone"');
    fromHost({ note: "Mine" });
    act(() => vi.advanceTimersByTime(5000));
    expect(shown("note")).toBe('"Mine"');
    set("note", "Mine again");
    fromHost({ note: "From my laptop" });
    expect(shown("note")).toBe('"Mine again"');
    act(() => vi.advanceTimersByTime(5000));
    expect(shown("note")).toBe('"From my laptop"');
    fromHost({});
    expect(shown("note")).toBe('"From my laptop"');
    expect(shown("other")).toBe('""');
  });
});
