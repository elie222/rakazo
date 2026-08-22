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

  it("does not treat longer tokens or email fragments as mentions", () => {
    expect(mentionedBotIds("@Chiefly owns email@Chief.example", members)).toEqual([]);
  });

  it("uses Unicode-aware mention boundaries", () => {
    expect(mentionedBotIds("π@Chief and @Chief猫", members)).toEqual([]);
    expect(mentionedBotIds("👋@Chief!", members)).toEqual(["chief"]);
  });

  it("accepts punctuation around a complete mention", () => {
    expect(mentionedBotIds("(@Chief), please take this", members)).toEqual(["chief"]);
  });

  it("wakes every member sharing an explicitly mentioned display name", () => {
    expect(
      mentionedBotIds("@Chief please compare notes", [
        ...members,
        { botId: "other-chief", name: "Chief" },
      ]),
    ).toEqual(["chief", "other-chief"]);
  });

  it("can match a shorter mention separately from a longer one", () => {
    expect(mentionedBotIds("@Chief of Staff sync with @Chief", members)).toEqual([
      "chief",
      "chief-of-staff",
    ]);
  });

  it("wakes several members at once", () => {
    const woken = mentionedBotIds("@Chief of Staff and @Accountant sync up", members);
    expect(woken.sort()).toEqual(["accountant", "chief-of-staff"]);
  });

  it("ignores a bare name with no at sign", () => {
    expect(mentionedBotIds("Accountant should look at this", members)).toEqual([]);
  });
});
