type Point = { x: number; y: number };
type View = { zoom: number; pan: Point; trackpad: boolean; cursor: Point };
export function createTouchNavigation(options: {
  size: () => { width: number; height: number; displayWidth: number; displayHeight: number };
  point: (x: number, y: number) => Point;
  move: (at: Point) => void;
  button: (at: Point, mask: number, down: boolean) => void;
  scroll: (at: Point, dx: number, dy: number) => void;
  view: (state: View) => void;
  now?: () => number;
}): {
  down(id: number, x: number, y: number): void;
  move(id: number, x: number, y: number): void;
  up(id: number): void;
  hold(): void;
  cancel(): void;
  setTrackpad(value: boolean): void;
  recenter(): void;
  resetZoom(): void;
  resize(): void;
};
