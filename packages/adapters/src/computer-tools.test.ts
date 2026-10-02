import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { computerObservation } from "./computer-support.js";
import type { UnchangedVisualStreak } from "./computer-tools.js";
import {
  advanceUnchangedVisualGuard,
  computerVisualActionKey,
  MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS,
  observationToolResult,
  parseComputerActions,
  unchangedVisualActionBlocked,
  unchangedVisualLoopToolResult,
  unchangedVisualStreakAfterPageBrowser,
} from "./computer-tools.js";

describe("computer tool bridge", () => {
  it("normalizes a bounded batch into provider-neutral actions", () => {
    expect(
      parseComputerActions([
        { kind: "click", x: 20.4, y: 30.6 },
        { kind: "type", text: "hello" },
        { kind: "scroll", direction: "up", amount: 999 },
        { kind: "focus", application: "xterm" },
      ]),
    ).toEqual([
      { kind: "pointer", x: 20, y: 31, type: "click", button: "left" },
      { kind: "clipboard", text: "hello" },
      { kind: "scroll", direction: "up", amount: 20 },
      { kind: "focus", application: "xterm" },
    ]);
  });

  it("keeps an optional URI on focus actions and rejects a missing application", () => {
    expect(
      parseComputerActions([
        { kind: "focus", application: "chromium", uri: "https://example.test" },
      ]),
    ).toEqual([{ kind: "focus", application: "chromium", uri: "https://example.test" }]);
    expect(() => parseComputerActions([{ kind: "focus" }])).toThrow(/application/);
    expect(() => parseComputerActions([{ kind: "focus", application: "   " }])).toThrow(
      /application/,
    );
  });

  it("requires a non-blank application on the focus tool variant", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "computer_act");
    const schema = tool?.inputSchema as {
      properties?: {
        actions?: {
          items?: {
            oneOf?: Array<{
              required?: string[];
              properties?: {
                kind?: { enum?: string[] };
                application?: { minLength?: number; pattern?: string };
              };
            }>;
          };
        };
      };
    };
    const items = schema?.properties?.actions?.items ?? {};
    const focus = items.oneOf?.find((branch) => branch.properties?.kind?.enum?.includes("focus"));
    const other = items.oneOf?.find((branch) => branch !== focus);
    expect(focus?.required).toEqual(["kind", "application"]);
    expect(focus?.properties?.application).toMatchObject({ minLength: 1, pattern: "\\S" });
    expect(other?.required).toEqual(["kind"]);
    expect(other?.properties?.kind?.enum).not.toContain("focus");
  });

  it("rejects batches whose expanded double-click actions exceed the limit", () => {
    expect(() =>
      parseComputerActions(
        Array.from({ length: 13 }, () => ({ kind: "click", x: 10, y: 10, double: true })),
      ),
    ).toThrow(/more than 24/);
  });

  it("returns observations as model-visible image content", () => {
    const observation = computerObservation(Uint8Array.from([1, 2, 3]), {
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    const result = observationToolResult(observation);
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "image", data: "AQID", mimeType: "image/png" },
    ]);
  });

  it("does not resend an unchanged screenshot", () => {
    const observation = computerObservation(Uint8Array.from([1, 2, 3]), {
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    const result = observationToolResult(observation, "observed", observation.frameId);

    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(
          "The previous screenshot remains valid; this identical frame was omitted.",
        ),
      }),
    ]);
    expect(result.content.some((part) => part.type === "image")).toBe(false);
    expect(result.details).toMatchObject({
      frameId: observation.frameId,
      screenUnchanged: true,
      screenshotOmitted: true,
      previousScreenshotValid: true,
    });
  });

  it("stops repeating an identical visual action after unchanged frames", () => {
    const observation = computerObservation(Uint8Array.from([1, 2, 3]), {
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    const scrollActions = parseComputerActions([{ kind: "scroll", direction: "down", amount: 3 }]);
    const otherScrollActions = parseComputerActions([
      { kind: "scroll", direction: "up", amount: 3 },
    ]);
    const scroll = computerVisualActionKey(scrollActions);
    const otherScroll = computerVisualActionKey(otherScrollActions);
    expect(scroll).toBeTypeOf("string");
    expect(otherScroll).not.toBe(scroll);
    expect(
      computerVisualActionKey(parseComputerActions([{ kind: "type", text: "hello" }])),
    ).toBeUndefined();

    let streak: UnchangedVisualStreak = { count: 0 };
    streak = advanceUnchangedVisualGuard(streak, observation.frameId).streak;

    for (let index = 0; index < MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS - 1; index += 1) {
      const guard = advanceUnchangedVisualGuard(streak, observation.frameId, scroll);
      streak = guard.streak;
      expect(guard.engaged).toBe(false);
    }
    expect(unchangedVisualActionBlocked(streak, scrollActions)).toBe(false);
    const early = observationToolResult(observation, "observed", observation.frameId, {
      unchangedVisualCount: streak.count,
    });
    expect(early.details).toMatchObject({
      previousScreenshotValid: true,
      unchangedVisualCount: streak.count,
    });
    expect(early.details).not.toMatchObject({ unchangedVisualLoop: true });

    const engaged = advanceUnchangedVisualGuard(streak, observation.frameId, scroll);
    streak = engaged.streak;
    expect(engaged.engaged).toBe(true);
    expect(streak.count).toBe(MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS);
    expect(unchangedVisualActionBlocked(streak, scrollActions)).toBe(true);
    expect(unchangedVisualActionBlocked(streak, otherScrollActions)).toBe(false);
    const preserved = advanceUnchangedVisualGuard(streak, observation.frameId);
    expect(preserved.streak.count).toBe(MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS);
    expect(unchangedVisualActionBlocked(preserved.streak, scrollActions)).toBe(true);

    const marked = observationToolResult(observation, "observed", observation.frameId, {
      unchangedVisualCount: streak.count,
    });
    expect(marked.content.some((part) => part.type === "image")).toBe(false);
    expect(marked.details).toMatchObject({
      screenUnchanged: true,
      screenshotOmitted: true,
      previousScreenshotValid: true,
      unchangedVisualLoop: true,
      unchangedVisualCount: MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS,
    });
    expect(marked.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("browser_snapshot"),
      }),
    );

    const refused = unchangedVisualLoopToolResult(streak);
    expect(refused.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("was not run again"),
      }),
    ]);
    expect(refused.details).toMatchObject({
      previousScreenshotValid: true,
      unchangedVisualLoop: true,
    });

    const changed = computerObservation(Uint8Array.from([9, 9, 9]), {
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    const reset = advanceUnchangedVisualGuard(streak, changed.frameId, scroll);
    expect(reset.engaged).toBe(false);
    expect(reset.streak.count).toBe(0);
    expect(unchangedVisualActionBlocked(reset.streak, scrollActions)).toBe(false);
    const refreshed = observationToolResult(changed, "observed", observation.frameId);
    expect(refreshed.content).toEqual([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "image" }),
    ]);
  });

  it("blocks a scroll padded with waits and still runs typing", () => {
    const observation = computerObservation(Uint8Array.from([1, 2, 3]), {
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    const scrollActions = parseComputerActions([{ kind: "scroll", direction: "down", amount: 3 }]);
    const scroll = computerVisualActionKey(scrollActions);
    let streak: UnchangedVisualStreak = { count: 0 };
    streak = advanceUnchangedVisualGuard(streak, observation.frameId).streak;
    for (let index = 0; index < MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS; index += 1) {
      streak = advanceUnchangedVisualGuard(streak, observation.frameId, scroll).streak;
    }
    const withType = parseComputerActions([
      { kind: "scroll", direction: "down", amount: 3 },
      { kind: "type", text: "hello" },
    ]);
    const withWait = parseComputerActions([
      { kind: "scroll", direction: "down", amount: 3 },
      { kind: "wait", ms: 100 },
    ]);
    const withTwoWaits = parseComputerActions([
      { kind: "scroll", direction: "down", amount: 3 },
      { kind: "wait", ms: 100 },
      { kind: "wait", ms: 100 },
    ]);

    expect(computerVisualActionKey(withType)).toBe(scroll);
    expect(computerVisualActionKey(withWait)).toBe(scroll);
    expect(unchangedVisualActionBlocked(streak, scrollActions)).toBe(true);
    expect(unchangedVisualActionBlocked(streak, withWait)).toBe(true);
    expect(unchangedVisualActionBlocked(streak, withTwoWaits)).toBe(true);
    expect(unchangedVisualActionBlocked(streak, withType)).toBe(false);
    expect(
      unchangedVisualActionBlocked(streak, parseComputerActions([{ kind: "type", text: "hello" }])),
    ).toBe(false);
  });

  it("clears the visual streak after a successful page mutation", () => {
    const engaged: UnchangedVisualStreak = {
      frameId: "frame-1",
      actionKey: "scroll",
      count: MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS,
    };
    const navigated = { url: "https://example.test", title: "Example" };
    const acted = { ok: true, completed: 1, url: "https://example.test", title: "Example" };
    const failed = { error: "could not navigate", fallback: "computer_act" as const };

    expect(unchangedVisualStreakAfterPageBrowser(engaged, "browser_navigate", navigated)).toEqual({
      count: 0,
    });
    expect(unchangedVisualStreakAfterPageBrowser(engaged, "browser_act", acted)).toEqual({
      count: 0,
    });
    expect(unchangedVisualStreakAfterPageBrowser(engaged, "browser_snapshot", navigated)).toEqual(
      engaged,
    );
    expect(unchangedVisualStreakAfterPageBrowser(engaged, "browser_navigate", failed)).toEqual(
      engaged,
    );
    expect(unchangedVisualStreakAfterPageBrowser(engaged, "browser_act", { ok: false })).toEqual(
      engaged,
    );
  });
});
