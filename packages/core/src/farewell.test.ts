import { describe, expect, it } from "vitest";
import { isFarewell } from "./farewell.js";

describe("isFarewell", () => {
  it.each([
    "That's all",
    "ok thanks, bye!",
    "Goodbye",
    "that'll be all for now",
    "hang up",
    "End the call.",
    "alright, I'm done, thanks",
  ])("hears %j as the end of the call", (text) => {
    expect(isFarewell(text)).toBe(true);
  });

  it.each([
    "bye the way, can you check the deploy",
    "that's all wrong, redo it",
    "tell me about goodbye songs",
    "I'm done with the draft, what's next",
    "",
    "before we wrap up that's all I had on the deploy today",
  ])("keeps the call going for %j", (text) => {
    expect(isFarewell(text)).toBe(false);
  });
});
