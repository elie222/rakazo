import { describe, expect, it } from "vitest";
import { consecutiveImageRun } from "./message-blocks.js";

describe("consecutiveImageRun", () => {
  it("returns null for non-image", () => {
    const items = [{ kind: "text" }, { kind: "image" }];
    expect(consecutiveImageRun(items, 0)).toBeNull();
  });
  it("returns null for non-first of run", () => {
    const items = [{ kind: "image" }, { kind: "image" }];
    expect(consecutiveImageRun(items, 1)).toBeNull();
  });
  it("returns single run for lone image", () => {
    const items = [{ kind: "text" }, { kind: "image" }, { kind: "text" }];
    expect(consecutiveImageRun(items, 1)).toEqual([{ kind: "image" }]);
  });
  it("returns full consecutive run", () => {
    const items = [{ kind: "image" }, { kind: "image" }, { kind: "file" }];
    expect(consecutiveImageRun(items, 0)).toEqual([{ kind: "image" }, { kind: "image" }]);
  });
});
