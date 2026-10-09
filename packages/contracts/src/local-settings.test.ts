import { describe, expect, it } from "vitest";
import { isLocalSettingsProcedure, LOCAL_SETTINGS_RPC } from "./local-settings.js";

describe("backup models in desktop local settings", () => {
  it.each(["models/backups", "models/setBackups"])(
    "allows %s through the shared settings gate",
    (procedure) => {
      expect(isLocalSettingsProcedure(`${LOCAL_SETTINGS_RPC}/${procedure}`)).toBe(true);
    },
  );
  it("does not widen the gate to unrelated bot actions", () => {
    expect(isLocalSettingsProcedure(`${LOCAL_SETTINGS_RPC}/bots/delete`)).toBe(false);
    expect(isLocalSettingsProcedure("/rpc/models/setBackups")).toBe(false);
  });
});
