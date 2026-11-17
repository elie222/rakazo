import { describe, expect, it } from "vitest";

import {
  deviceTimezoneStep,
  parseKeptTimezone,
  sameTimeZone,
  timeZonePlace,
} from "./device-timezone.js";

describe("deviceTimezoneStep", () => {
  it("adopts the device zone for an account that has none", () => {
    expect(deviceTimezoneStep("Asia/Tokyo", null, null)).toBe("adopt");
  });

  it("does nothing when the account already uses the device zone, spellings aside", () => {
    expect(deviceTimezoneStep("Asia/Tokyo", "Asia/Tokyo", null)).toBeNull();
    expect(deviceTimezoneStep("Asia/Calcutta", "Asia/Kolkata", null)).toBeNull();
  });

  it("asks when the device zone differs from the account's", () => {
    expect(deviceTimezoneStep("Asia/Tokyo", "Europe/London", null)).toBe("ask");
  });

  const kept = { device: "Asia/Tokyo", account: "Europe/London" };

  it("does not ask again for a device zone the user kept their zone for", () => {
    expect(deviceTimezoneStep("Asia/Tokyo", "Europe/London", kept)).toBeNull();
  });

  it("asks again once the device moves to yet another zone", () => {
    expect(deviceTimezoneStep("America/New_York", "Europe/London", kept)).toBe("ask");
  });

  it("asks again when the account has since moved to another zone", () => {
    expect(deviceTimezoneStep("Asia/Tokyo", "America/New_York", kept)).toBe("ask");
  });
});

describe("sameTimeZone", () => {
  it("matches a zone with its legacy alias but not a different zone", () => {
    expect(sameTimeZone("Asia/Kolkata", "Asia/Calcutta")).toBe(true);
    expect(sameTimeZone("Pacific/Auckland", "Europe/London")).toBe(false);
  });
});

describe("timeZonePlace", () => {
  it("names the place a zone is named after", () => {
    expect(timeZonePlace("Asia/Tokyo")).toBe("Tokyo");
    expect(timeZonePlace("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(timeZonePlace("UTC")).toBe("UTC");
    expect(timeZonePlace("Etc/GMT-9")).toBe("GMT+9");
  });
});

describe("parseKeptTimezone", () => {
  it("reads a stored Keep and rejects anything else", () => {
    expect(parseKeptTimezone({ device: "Asia/Tokyo", account: "UTC" })).toEqual({
      device: "Asia/Tokyo",
      account: "UTC",
    });
    expect(parseKeptTimezone("Asia/Tokyo")).toBeNull();
    expect(parseKeptTimezone({ device: "Asia/Tokyo" })).toBeNull();
  });
});
