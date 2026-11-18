import { describe, expect, it } from "vitest";
import { canDoubleTapReact, createDoubleTapDetector } from "./double-tap";

const point = (time: number, x = 0, y = 0) => ({ time, x, y });

describe("double tap", () => {
  it("fires once for a close pair and leaves a third tap unpaired", () => {
    const detector = createDoubleTapDetector();
    detector.start(point(0));
    expect(detector.end(point(30))).toBe(false);
    detector.start(point(100, 3));
    expect(detector.end(point(130, 3))).toBe(true);
    detector.start(point(180));
    expect(detector.end(point(210))).toBe(false);
  });

  it("accepts a relaxed pair: a 280 ms gap and a 30 pt drift", () => {
    const detector = createDoubleTapDetector();
    detector.start(point(0));
    detector.end(point(110));
    detector.start(point(390, 30));
    expect(detector.end(point(500, 30))).toBe(true);
  });

  it.each([point(400), point(100, 50), point(100, 0, 50)])(
    "rejects a slow or distant second tap: %j",
    (second) => {
      const detector = createDoubleTapDetector();
      detector.start(point(0));
      detector.end(point(20));
      detector.start(second);
      expect(detector.end({ ...second, time: second.time + 20 })).toBe(false);
    },
  );

  it.each(["move", "terminate", "hold"])("rejects %s and clears the pair", (reason) => {
    const detector = createDoubleTapDetector();
    detector.start(point(0));
    detector.end(point(20));
    detector.start(point(50));
    if (reason === "move") detector.move(point(60, 11));
    if (reason === "terminate") detector.cancel();
    expect(detector.end(point(reason === "hold" ? 350 : 80))).toBe(false);
    detector.start(point(370));
    expect(detector.end(point(390))).toBe(false);
  });
});

describe("double tap reaction eligibility", () => {
  it("allows only nonempty plain content with reactions enabled", () => {
    expect(
      canDoubleTapReact(
        true,
        ["text", "image", "file", "chart"].map((kind) => ({ kind })),
        false,
      ),
    ).toBe(true);
    expect(canDoubleTapReact(false, [{ kind: "text" }], false)).toBe(false);
    expect(canDoubleTapReact(true, [], false)).toBe(false);
    expect(canDoubleTapReact(true, [{ kind: "text" }], true)).toBe(false);
  });

  it.each([
    "ask",
    "choice",
    "mcp_approval",
    "connect",
    "app_connect",
    "computer",
    "call_request",
    "voice_call",
    "skill_draft",
    "routine",
    "subagent",
    "steps",
    "progress",
    "handoff",
    "card",
    "unknown",
  ])("rejects mixed content containing %s", (kind) => {
    expect(canDoubleTapReact(true, [{ kind: "text" }, { kind }], false)).toBe(false);
  });
});
