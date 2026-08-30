import { describe, expect, it } from "vitest";
import { parsePhoneCommand } from "./phone-commands.js";

describe("parsePhoneCommand", () => {
  it("parses the minimal command set case-insensitively", () => {
    expect(parsePhoneCommand("YES")).toBe("approve");
    expect(parsePhoneCommand("yes")).toBe("approve");
    expect(parsePhoneCommand(" yes ")).toBe("approve");
    expect(parsePhoneCommand("NO")).toBe("decline");
    expect(parsePhoneCommand("no")).toBe("decline");
    expect(parsePhoneCommand("LEAVE")).toBe("leave");
    expect(parsePhoneCommand("leave")).toBe("leave");
  });

  it("treats everything else as a normal message", () => {
    expect(parsePhoneCommand("yes please")).toBeNull();
    expect(parsePhoneCommand("YES!")).toBeNull();
    expect(parsePhoneCommand("")).toBeNull();
    expect(parsePhoneCommand("hello")).toBeNull();
    expect(parsePhoneCommand("leave the group")).toBeNull();
  });
});
