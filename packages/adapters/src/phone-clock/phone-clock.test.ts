import { NativeClockOperation } from "@rakazo/contracts";
import { toolRequiresApproval } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { selectBuiltinToolsForRun } from "../runs/tools/run-tool-selection.js";

describe("phone clock tools", () => {
  it("offers gated clock writes only for a run with a clock-capable device", () => {
    const options = {
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
    };
    const ordinary = selectBuiltinToolsForRun(options).map(({ name }) => name);
    const phone = selectBuiltinToolsForRun({ ...options, phoneClockAvailable: true }).map(
      ({ name }) => name,
    );
    for (const name of ["start_phone_timer", "set_phone_alarm"]) {
      expect(ordinary).not.toContain(name);
      expect(phone).toContain(name);
      expect(toolRequiresApproval(name, false)).toBe(true);
    }
  });

  it("accepts only a valid duration or local alarm time", () => {
    for (const durationSeconds of [0, 1.5, 86_401]) {
      expect(
        NativeClockOperation.safeParse({ action: "start_phone_timer", input: { durationSeconds } })
          .success,
      ).toBe(false);
    }
    expect(
      NativeClockOperation.safeParse({
        action: "set_phone_alarm",
        input: { hour: 7, minute: 30, repeat: true },
      }).success,
    ).toBe(false);
    expect(
      NativeClockOperation.parse({ action: "set_phone_alarm", input: { hour: 7, minute: 30 } }),
    ).toEqual({ action: "set_phone_alarm", input: { hour: 7, minute: 30 } });
  });
});
