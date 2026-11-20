import { describe, expect, it } from "vitest";
import { BotSchema, UpdateBotInput } from "./bot.js";

describe("UpdateBotInput hostDeviceId", () => {
  const botId = `c${"a".repeat(24)}`;

  it("sets a device, clears it with null, and stays absent when omitted", () => {
    expect(UpdateBotInput.parse({ botId, hostDeviceId: "device-1" }).hostDeviceId).toBe("device-1");
    expect(UpdateBotInput.parse({ botId, hostDeviceId: null }).hostDeviceId).toBeNull();
    expect(UpdateBotInput.parse({ botId }).hostDeviceId).toBeUndefined();
    expect(UpdateBotInput.safeParse({ botId, hostDeviceId: "" }).success).toBe(false);
  });
});

describe("BotSchema hostDevice", () => {
  it("defaults to null and keeps the owner of a bound computer", () => {
    expect(BotSchema.pick({ hostDevice: true }).parse({})).toEqual({ hostDevice: null });
    expect(
      BotSchema.pick({ hostDevice: true }).parse({
        hostDevice: {
          id: "device-1",
          name: "Desk PC",
          platform: "darwin",
          ownerUserId: "user-1",
        },
      }),
    ).toEqual({
      hostDevice: { id: "device-1", name: "Desk PC", platform: "darwin", ownerUserId: "user-1" },
    });
  });
});
