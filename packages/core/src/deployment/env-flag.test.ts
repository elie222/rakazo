import { describe, expect, it } from "vitest";
import { parseEnvFlag } from "./env-flag.js";

describe("parseEnvFlag", () => {
  it.each(["false", "FALSE", "False", " false ", "0"])("reads %j as off", (value) => {
    expect(parseEnvFlag("X", value, true)).toBe(false);
  });

  it.each(["true", "TRUE", " true ", "1"])("reads %j as on", (value) => {
    expect(parseEnvFlag("X", value, false)).toBe(true);
  });

  it("uses the default when unset or blank", () => {
    expect(parseEnvFlag("X", undefined, true)).toBe(true);
    expect(parseEnvFlag("X", "  ", false)).toBe(false);
  });

  it.each(["no", "off", "flase", "2"])("refuses %j", (value) => {
    expect(() => parseEnvFlag("X", value, true)).toThrow("X must be true or false");
  });
});
