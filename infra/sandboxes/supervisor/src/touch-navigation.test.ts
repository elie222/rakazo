import { describe, expect, it, vi } from "vitest";
import { createTouchNavigation } from "../../computer/touch-navigation.js";

function fixture() {
  let time = 1000;
  const move = vi.fn(),
    button = vi.fn(),
    scroll = vi.fn(),
    view = vi.fn();
  const nav = createTouchNavigation({
    size: () => ({ width: 1200, height: 800, displayWidth: 600, displayHeight: 400 }),
    point: (x, y) => ({ x: x * 2, y: y * 2 }),
    move,
    button,
    scroll,
    view,
    now: () => time,
  });
  return {
    nav,
    move,
    button,
    scroll,
    view,
    tick: (ms: number) => {
      time += ms;
    },
  };
}
describe("touch computer navigation", () => {
  it("taps at the touched pixel and drags without leaving a button held", () => {
    const f = fixture();
    f.nav.down(1, 50, 40);
    f.nav.up(1);
    expect(f.button.mock.calls).toEqual([
      [{ x: 100, y: 80 }, 1, true],
      [{ x: 100, y: 80 }, 1, false],
    ]);
    f.button.mockClear();
    f.nav.down(1, 50, 40);
    f.nav.move(1, 80, 70);
    f.nav.cancel();
    expect(f.button.mock.calls).toEqual([
      [{ x: 100, y: 80 }, 1, true],
      [{ x: 160, y: 140 }, 1, false],
    ]);
  });
  it("moves a relative pointer, taps there, double-tap drags and recenters", () => {
    const f = fixture();
    f.nav.setTrackpad(true);
    f.nav.down(1, 10, 10);
    f.nav.move(1, 20, 20);
    f.nav.up(1);
    expect(f.move).toHaveBeenLastCalledWith({ x: 620, y: 420 });
    expect(f.button).not.toHaveBeenCalled();
    f.nav.down(1, 10, 10);
    f.nav.up(1);
    expect(f.button).toHaveBeenLastCalledWith({ x: 620, y: 420 }, 1, false);
    f.tick(100);
    f.nav.down(1, 10, 10);
    f.nav.move(1, 30, 30);
    f.nav.up(1);
    expect(f.button).toHaveBeenLastCalledWith({ x: 660, y: 460 }, 1, false);
    f.nav.recenter();
    expect(f.move).toHaveBeenLastCalledWith({ x: 600, y: 400 });
  });
  it("right-clicks on a long press or two-finger tap without a left click", () => {
    const f = fixture();
    f.nav.down(1, 20, 20);
    f.tick(550);
    f.nav.hold();
    f.nav.up(1);
    expect(f.button.mock.calls.map((c) => c.slice(1))).toEqual([
      [4, true],
      [4, false],
    ]);
    f.button.mockClear();
    f.nav.down(1, 20, 20);
    f.nav.down(2, 40, 20);
    f.tick(100);
    f.nav.up(1);
    f.nav.up(2);
    expect(f.button.mock.calls.map((c) => c.slice(1))).toEqual([
      [4, true],
      [4, false],
    ]);
  });
  it("scrolls with two fingers, but pans the zoomed desktop", () => {
    const f = fixture();
    f.nav.down(1, 50, 50);
    f.nav.down(2, 150, 50);
    f.nav.move(1, 50, 60);
    f.nav.move(2, 150, 60);
    f.nav.move(1, 50, 80);
    f.nav.move(2, 150, 80);
    f.nav.up(1);
    f.nav.up(2);
    expect(f.scroll).toHaveBeenCalled();
    expect(f.button).not.toHaveBeenCalled();
    f.scroll.mockClear();
    f.nav.down(1, 50, 50);
    f.nav.down(2, 150, 50);
    f.nav.move(2, 250, 50);
    f.nav.up(1);
    f.nav.up(2);
    expect(f.view.mock.lastCall?.[0].zoom).toBe(2);
    f.nav.down(1, 50, 50);
    f.nav.down(2, 150, 50);
    f.nav.move(1, 50, 70);
    f.nav.move(2, 150, 70);
    f.nav.up(1);
    f.nav.up(2);
    expect(f.view.mock.lastCall?.[0].pan.y).toBeGreaterThan(0);
    expect(f.scroll).not.toHaveBeenCalled();
    f.nav.resetZoom();
    expect(f.view.mock.lastCall?.[0]).toMatchObject({ zoom: 1, pan: { x: 0, y: 0 } });
  });
  it("releases a drag when switching modes and clamps the pointer", () => {
    const f = fixture();
    f.nav.down(1, 0, 0);
    f.nav.move(1, 900, 900);
    f.nav.setTrackpad(true);
    expect(f.button).toHaveBeenLastCalledWith({ x: 1199, y: 799 }, 1, false);
  });
});
