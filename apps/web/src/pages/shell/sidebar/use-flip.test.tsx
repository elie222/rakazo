// @vitest-environment jsdom
import type { RefObject } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlip } from "./use-flip";

const rows = ["one", "two", "three"];
let order = [...rows];
let root: Root;
let container: HTMLDivElement;
let animate: ReturnType<typeof vi.fn>;

function Rows({ listRef }: { listRef: RefObject<HTMLDivElement | null> }) {
  useFlip(listRef, order.join(","));
  return (
    <div ref={listRef}>
      {order.map((key) => (
        <div key={key} data-flip-key={key} />
      ))}
    </div>
  );
}

function place(element: Element) {
  const key = element.getAttribute("data-flip-key");
  const index = order.indexOf(key ?? "");
  return { left: 0, top: index * 20, width: 200, height: 20 } as DOMRect;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  order = [...rows];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  animate = vi.fn();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return place(this);
  });
  Element.prototype.animate = animate.mockImplementation(
    () =>
      ({
        cancel: vi.fn(),
        addEventListener: vi.fn(),
      }) as unknown as Animation,
  ) as unknown as typeof Element.prototype.animate;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useFlip", () => {
  it("animates a row from where it was to where it landed", async () => {
    const listRef = { current: null } as RefObject<HTMLDivElement | null>;
    await act(async () => root.render(<Rows listRef={listRef} />));
    expect(animate).not.toHaveBeenCalled();

    order = ["two", "one", "three"];
    await act(async () => root.render(<Rows listRef={listRef} />));

    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls.map((call) => call[0]?.[0])).toEqual([
      { transform: "translate(0px, 20px)" },
      { transform: "translate(0px, -20px)" },
    ]);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 200 });
  });

  it("stays still when the order does not change", async () => {
    const listRef = { current: null } as RefObject<HTMLDivElement | null>;
    await act(async () => root.render(<Rows listRef={listRef} />));
    await act(async () => root.render(<Rows listRef={listRef} />));
    expect(animate).not.toHaveBeenCalled();
  });
});
