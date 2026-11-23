import type { HostScreenActResult, HostScreenObservation } from "@rakazo/adapters/host-screen";
import { expect, it } from "vitest";
import type { UserComputerFixture } from "../cases.js";
import { WINDOWS_SCREEN_SUITE } from "./windows-screen.js";

type Request = Parameters<UserComputerFixture["gateway"]["request"]>[1];

it("checks a saved badge code and keeps it out of the initial accessibility tree", async () => {
  const scenario = WINDOWS_SCREEN_SUITE.cases.find(({ id }) => id === "inspection-badge")!;
  const fixture = scenario.userComputer!();
  const signal = new AbortController().signal;

  async function request<T>(input: Request) {
    for await (const value of fixture.gateway.request<T>("user", input, signal)) return value;
    throw new Error("The synthetic desktop didn't answer");
  }

  const form = await request<HostScreenActResult>({
    method: "screenAct",
    botId: "bot",
    app: "workbench",
    includeScreenshot: true,
    actions: [
      { kind: "clickControl", role: "button", name: "New work order" },
      {
        kind: "setControl",
        role: "textfield",
        name: "Summary",
        value: "Verify loading bay extinguisher",
      },
      { kind: "setControl", role: "textfield", name: "Assignee", value: "Avery" },
    ],
  });
  expect(form.completed).toBe(3);
  expect(form.observation?.tree).toContain("Inspection code");
  expect(form.observation?.tree).not.toContain("N7VX");
  expect(form.observation?.image).toMatchObject({ mimeType: "image/png" });
  expect(fixture.snapshot().saved).toBeNull();

  const saved = await request<HostScreenActResult>({
    method: "screenAct",
    botId: "bot",
    app: "workbench",
    actions: [
      { kind: "setControl", role: "textfield", name: "Inspection code", value: "N7VX" },
      { kind: "clickControl", role: "button", name: "Save work order" },
    ],
  });
  expect(saved.completed).toBe(2);
  const after = await request<HostScreenObservation>({
    method: "screenObserve",
    botId: "bot",
    app: "workbench",
  });
  expect(after.image).toBeUndefined();
  expect(fixture.snapshot()).toEqual({
    saved: {
      summary: "Verify loading bay extinguisher",
      assignee: "Avery",
      inspectionCode: "N7VX",
    },
    toolCalls: 3,
    screenshots: 1,
  });
  expect(scenario.userComputer!().snapshot()).toEqual({
    saved: null,
    toolCalls: 0,
    screenshots: 0,
  });
});
