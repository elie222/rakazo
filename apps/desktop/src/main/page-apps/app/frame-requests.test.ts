import { describe, expect, it } from "vitest";
import { createRateLimit, frameRequest } from "./frame-requests.js";

describe("frameRequest", () => {
  it("takes a question with an id and refuses an empty, long or unnamed one", () => {
    expect(frameRequest({ type: "rakazo-page:ask", id: "q1", text: "  How many? " })).toEqual({
      kind: "ask",
      id: "q1",
      text: "How many?",
    });
    expect(frameRequest({ type: "rakazo-page:ask", id: "q1", text: "   " })).toBeNull();
    expect(frameRequest({ type: "rakazo-page:ask", id: "q1", text: "x".repeat(2_001) })).toBeNull();
    expect(frameRequest({ type: "rakazo-page:ask", text: "Hi" })).toBeNull();
  });

  it("takes a notification as one line each and refuses one without a usable title", () => {
    expect(frameRequest({ type: "rakazo-page:notify", title: "Done\nnow", body: "a\tb" })).toEqual({
      kind: "notify",
      title: "Done now",
      body: "a b",
    });
    expect(frameRequest({ type: "rakazo-page:notify", title: "Done" })).toMatchObject({ body: "" });
    expect(frameRequest({ type: "rakazo-page:notify", title: 3 })).toBeNull();
    expect(frameRequest({ type: "rakazo-page:notify", title: "x".repeat(121) })).toBeNull();
  });

  it("drops messages of any other type", () => {
    expect(frameRequest({ type: "rakazo-page:height", height: 3 })).toBeNull();
    expect(frameRequest("rakazo-page:ask")).toBeNull();
  });
});

describe("createRateLimit", () => {
  it("allows one call per interval", () => {
    let now = 0;
    const allowed = createRateLimit(10_000, () => now);
    expect(allowed()).toBe(true);
    now = 9_999;
    expect(allowed()).toBe(false);
    now = 10_000;
    expect(allowed()).toBe(true);
  });
});
