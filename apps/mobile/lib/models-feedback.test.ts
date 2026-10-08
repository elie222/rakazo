import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screen = readFileSync(resolve(mobileRoot, "app/(settings)/models.tsx"), "utf8");

function sliceBetween(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("Models save feedback", () => {
  it("shows errors under the buttons that produced them and announces results", () => {
    const header = screen.slice(
      screen.indexOf('{t("Active model")}'),
      screen.indexOf('{t("Providers")}'),
    );
    expect(header).not.toContain("{error ?");
    expect(header).not.toContain("{notice ?");
    const feedback = sliceBetween(screen, "const feedback =", "function disclosureRow(");
    expect(feedback).toContain("styles.error");
    expect(feedback).not.toContain("styles.notice");
    expect(feedback).not.toContain("notice ?");
    expect(screen).not.toContain("tokens.success");
    expect(screen).not.toContain("selected.billing");
    expect(screen).toMatch(
      /t\("Find models"\)\}[\s\S]*?prominence="secondary"[\s\S]*?\/>\s*\{feedbackAnchor === "probe" \? feedback : null\}/,
    );
    expect(screen).toMatch(
      /\{compatKeySection\}\s*\{saveRow\}\s*\{feedbackAnchor === "probe" \? null : feedback\}/,
    );
    expect(screen).toMatch(
      /\{saveRow\}\s*\{feedbackAnchor === "model" \? feedback : null\}\s*<View style=\{styles\.maintenanceSection\}>\{catalogConnectionControls\}<\/View>\s*\{feedbackAnchor === "model" \? null : feedback\}/,
    );
    expect(screen).toMatch(/\{catalogConnectionControls\}\s*\{feedback\}/);
    const publish = sliceBetween(screen, "function publishFeedback(", "function clearFeedback(");
    expect(publish).toContain("setFeedbackAnchor(anchor)");
    expect(publish).toContain("AccessibilityInfo.announceForAccessibility(message)");
    expect(screen).not.toContain("}, [error, notice]);");
  });

  it("lands a finished probe under Find models even if Save moved the anchor", () => {
    const probe = sliceBetween(
      screen,
      "async function probeServerModels()",
      "async function setModelDefault()",
    );
    expect(probe.match(/publishFeedback\(\s*"probe"/g)).toHaveLength(2);
    const save = sliceBetween(
      screen,
      "async function connectKey()",
      "async function finishSubscriptionSignIn(",
    );
    expect(save).toContain('publishFeedback("connection"');
    expect(save).not.toContain('publishFeedback("probe"');
    const modelSwitch = sliceBetween(
      screen,
      "async function setModelDefault()",
      "async function disconnectCredential()",
    );
    expect(modelSwitch).toContain('publishFeedback("model"');
  });

  it("clears the probe anchor when switching providers or disconnecting", () => {
    const choose = sliceBetween(
      screen,
      "function chooseProvider(",
      "async function probeServerModels()",
    );
    expect(choose).toContain("clearFeedback()");
    const disconnect = sliceBetween(
      screen,
      "async function disconnectCredential()",
      "function stageCompatibleModelId(",
    );
    expect(disconnect).toContain("clearFeedback()");
    expect(disconnect).toContain('publishFeedback("connection"');
  });

  it("clears the last result before rejecting a limit", () => {
    const connect = sliceBetween(
      screen,
      "async function connectKey()",
      "async function finishSubscriptionSignIn(",
    );
    const cleared = connect.indexOf("clearFeedback()");
    expect(cleared).toBeGreaterThan(-1);
    expect(cleared).toBeLessThan(connect.indexOf("parseModelMaxTokens("));
  });
});
