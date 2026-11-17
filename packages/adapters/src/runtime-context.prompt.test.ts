import { describe, expect, it } from "vitest";
import {
  OMITTED_AFTER_USE,
  OMITTED_BEFORE_USE,
  OMITTED_TEXT_BEFORE_USE,
  SCREENSHOT_REMOVED_NOTE,
  STALE_PAGE_STATE_NOTE,
} from "./runtime-context.prompt.js";

describe("context trimming notes", () => {
  it("renders each note as the model reads it", () => {
    expect(SCREENSHOT_REMOVED_NOTE).toMatchInlineSnapshot(
      `"[Older screenshot removed; observe again if needed]"`,
    );
    expect(STALE_PAGE_STATE_NOTE).toMatchInlineSnapshot(
      `"[Earlier page state trimmed to save context. Facts you still need from that page should already be in your notes or tracker; otherwise take a fresh snapshot.]"`,
    );
    expect(OMITTED_BEFORE_USE).toMatchInlineSnapshot(
      `"[Tool result truncated to fit context; omitted evidence is unavailable.]"`,
    );
    expect(OMITTED_TEXT_BEFORE_USE).toMatchInlineSnapshot(
      `"[Tool result truncated to fit context; inspect original evidence before claiming omitted details.]"`,
    );
    expect(OMITTED_AFTER_USE).toMatchInlineSnapshot(
      `"[Earlier result shortened after you read it; statements made from it stand. Re-run the tool only if you need the omitted text.]"`,
    );
  });
});
