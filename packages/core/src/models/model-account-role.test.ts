import type { ModelRoleChoice, ModelRoleSettings } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { createAccountModelRole } from "./model-account-role.js";

const choice = (modelId: string): ModelRoleChoice => ({
  provider: "openai-compatible",
  modelId,
  credentialId: "fixture-account",
});
function setup() {
  let settings: ModelRoleSettings = { primary: choice("first"), backups: [choice("second")] };
  const save = vi.fn(async (patch: Partial<ModelRoleSettings>) => {
    settings = { ...settings, ...patch };
    return settings;
  });
  const controller = createAccountModelRole(
    {
      load: async () => settings,
      catalog: async () => [],
      save,
    },
    crypto.randomUUID(),
  );
  return { controller, save };
}
it("keeps selection, ordering, removal and effort on the ordinary role contract", async () => {
  const { controller } = setup();
  await controller.load();
  await controller.select("add", choice("third"));
  await controller.move(choice("third"), -2);
  expect(controller.snapshot().settings).toMatchObject({
    primary: choice("third"),
    backups: [choice("first"), choice("second")],
  });
  await controller.thinking("high");
  expect(controller.snapshot().settings?.primary?.thinkingLevel).toBe("high");
  await controller.remove(choice("third"));
  expect(controller.snapshot().settings).toMatchObject({
    primary: choice("first"),
    backups: [choice("second")],
  });
  await controller.select("primary", null);
  expect(controller.snapshot().settings).toMatchObject({
    primary: null,
    backups: [choice("second")],
  });
});
it("serializes rapid selections and keeps every unique fallback", async () => {
  const { controller } = setup();
  await controller.load();
  await Promise.all([
    controller.select("add", choice("third")),
    controller.select("add", choice("fourth")),
  ]);
  await controller.select("add", choice("third"));
  expect(controller.snapshot().settings?.backups).toEqual([
    choice("second"),
    choice("third"),
    choice("fourth"),
  ]);
});
it("restores the confirmed list after a failed write", async () => {
  const { controller, save } = setup();
  await controller.load();
  save.mockRejectedValueOnce(new Error("offline"));
  await controller.remove(choice("first"));
  expect(controller.snapshot()).toMatchObject({
    error: "offline",
    settings: { primary: choice("first"), backups: [choice("second")] },
  });
});
