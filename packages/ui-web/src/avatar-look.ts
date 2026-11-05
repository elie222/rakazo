/**
 * Hovered bot faces turn toward the pointer. One passive pointer listener and one animation
 * frame loop serve the whole page, and only the face under the pointer (plus any face still
 * springing back) is touched each frame. Transforms are written straight to the SVG, never
 * through React state.
 *
 * - A spring with a little overshoot moves the eyes, and the body follows at 30%.
 * - The far eye narrows and both eyes tilt slightly, a small pseudo-3D turn.
 * - A face that is being looked at blinks now and then.
 */
const STIFFNESS = 0.17;
const DAMPING = 0.74;
/** How far the eyes travel, in 100-unit view box steps. */
const REACH_X = 9;
const REACH_Y = 7;
const BLINK_MS = 170;

type Spring = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  blinkAt: number;
  nextBlink: number;
};

const springs = new Map<SVGSVGElement, Spring>();
let hovered: SVGSVGElement | null = null;
let frame = 0;
let faces = 0;
let listening = false;

/** A face is the hovered element itself, or the face inside the row or button under the pointer. */
function faceAt(target: EventTarget | null): SVGSVGElement | null {
  if (!(target instanceof Element)) return null;
  const own = target.closest<SVGSVGElement>("svg[data-look]");
  if (own) return own;
  const host = target.closest(
    "a, button, [role='button'], [role='option'], [role='menuitem'], [role='status']",
  );
  return host?.querySelector<SVGSVGElement>("svg[data-look]") ?? null;
}

function aim(face: SVGSVGElement, event: PointerEvent | null) {
  let spring = springs.get(face);
  if (!spring) {
    spring = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, blinkAt: 0, nextBlink: 0 };
    spring.nextBlink = performance.now() + 1400;
    springs.set(face, spring);
  }
  if (event) {
    const box = face.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    const distance = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, distance / (box.width * 0.9));
    spring.tx = (dx / distance) * reach * REACH_X;
    spring.ty = (dy / distance) * reach * REACH_Y;
  } else {
    spring.tx = 0;
    spring.ty = 0;
  }
  if (!frame) frame = requestAnimationFrame(step);
}

function paint(face: SVGSVGElement, spring: Spring, now: number) {
  const looks = face.querySelectorAll<SVGGElement>(".avatar-look");
  const body = face.querySelector<SVGElement>(".avatar-body");
  if (!looks.length) return;
  const unit = Number(face.dataset.look) || 1;
  const nx = Math.max(-1, Math.min(1, spring.x / REACH_X));
  const ny = Math.max(-1, Math.min(1, spring.y / REACH_Y));
  let lid = 1;
  if (spring.blinkAt) {
    const progress = (now - spring.blinkAt) / BLINK_MS;
    if (progress >= 1) spring.blinkAt = 0;
    else lid = 1 - 0.88 * Math.sin(Math.PI * progress);
  }
  const turn = `translate(${(spring.x * unit).toFixed(2)}px, ${(spring.y * unit).toFixed(2)}px) rotate(${(nx * 7).toFixed(2)}deg)`;
  for (const look of looks) look.style.transform = turn;
  const widths = [
    1 - 0.2 * Math.max(0, nx) + 0.08 * Math.max(0, -nx),
    1 - 0.2 * Math.max(0, -nx) + 0.08 * Math.max(0, nx),
  ];
  face.querySelectorAll<SVGElement>(".avatar-look .avatar-eye").forEach((eye, index) => {
    eye.style.transform = `scale(${(widths[index % 2] ?? 1).toFixed(3)}, ${(lid * (1 - 0.06 * Math.abs(ny))).toFixed(3)})`;
  });
  if (body)
    body.style.transform = `translate(${(spring.x * 0.3 * unit).toFixed(2)}px, ${(spring.y * 0.3 * unit).toFixed(2)}px)`;
}

function rest(face: SVGSVGElement) {
  for (const element of face.querySelectorAll<SVGElement>(
    ".avatar-look, .avatar-eye, .avatar-body",
  ))
    element.style.transform = "";
}

function step(now: number) {
  frame = 0;
  let moving = false;
  for (const [face, spring] of springs) {
    if (!face.isConnected) {
      springs.delete(face);
      continue;
    }
    spring.vx = (spring.vx + (spring.tx - spring.x) * STIFFNESS) * DAMPING;
    spring.vy = (spring.vy + (spring.ty - spring.y) * STIFFNESS) * DAMPING;
    spring.x += spring.vx;
    spring.y += spring.vy;
    if (face === hovered && !spring.blinkAt && now > spring.nextBlink) {
      spring.blinkAt = now;
      spring.nextBlink = now + 2600 + Math.random() * 3000;
    }
    paint(face, spring, now);
    const settled =
      Math.abs(spring.tx - spring.x) < 0.03 &&
      Math.abs(spring.ty - spring.y) < 0.03 &&
      Math.abs(spring.vx) < 0.02 &&
      Math.abs(spring.vy) < 0.02 &&
      !spring.blinkAt;
    if (face === hovered || !settled) moving = true;
    else if (!spring.tx && !spring.ty) {
      rest(face);
      springs.delete(face);
    }
  }
  if (moving) frame = requestAnimationFrame(step);
}

function onPointerMove(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  const face = faceAt(event.target);
  if (hovered && hovered !== face) aim(hovered, null);
  hovered = face;
  if (face) aim(face, event);
}

function onLeave() {
  if (hovered) aim(hovered, null);
  hovered = null;
}

/** Called by each face while mounted; the page listens only while a face is on it. */
export function watchAvatarLook(): () => void {
  faces++;
  if (!listening && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("mouseleave", onLeave);
    listening = true;
  }
  return () => {
    faces--;
    if (faces > 0 || !listening) return;
    window.removeEventListener("pointermove", onPointerMove);
    document.documentElement.removeEventListener("mouseleave", onLeave);
    listening = false;
    hovered = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const face of springs.keys()) rest(face);
    springs.clear();
  };
}
