import { describe, expect, it } from "vitest";
import { mentionedBotIds } from "./channel-mentions.js";

const members = [
  { botId: "chief", name: "Chief" },
  { botId: "chief-of-staff", name: "Chief of Staff" },
  { botId: "accountant", name: "Accountant" },
];

describe("channel mentions", () => {
  it("wakes nobody when no one is named", () => {
    expect(mentionedBotIds("shipping the release today", members)).toEqual([]);
  });

  it("wakes only the mentioned member", () => {
    expect(mentionedBotIds("@Accountant can you check the invoice", members)).toEqual([
      "accountant",
    ]);
  });

  it("is case insensitive", () => {
    expect(mentionedBotIds("hey @accountant", members)).toEqual(["accountant"]);
  });

  it("prefers the longest matching name so a prefix bot is not also woken", () => {
    expect(mentionedBotIds("@Chief of Staff please take this", members)).toEqual([
      "chief-of-staff",
    ]);
  });

  it("still wakes the shorter name when it is the one mentioned", () => {
    expect(mentionedBotIds("@Chief please take this", members)).toEqual(["chief"]);
  });

  it("wakes several members at once", () => {
    const woken = mentionedBotIds("@Chief of Staff and @Accountant sync up", members);
    expect(woken.sort()).toEqual(["accountant", "chief-of-staff"]);
  });

  it("ignores a bare name with no at sign", () => {
    expect(mentionedBotIds("Accountant should look at this", members)).toEqual([]);
  });
});
