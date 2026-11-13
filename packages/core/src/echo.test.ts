import { describe, expect, it } from "vitest";
import { isEchoOfSpeech, SpokenMemory } from "./echo.js";

const SPOKEN = "I'm here and hearing you…";

describe("isEchoOfSpeech", () => {
  it("catches a fragment of the reply that just played", () => {
    expect(isEchoOfSpeech("I am here in", SPOKEN)).toBe(true);
  });

  it("catches a fragment with filler around it", () => {
    expect(isEchoOfSpeech("hey I am here and here", SPOKEN)).toBe(true);
  });

  it("keeps a genuine short turn", () => {
    expect(isEchoOfSpeech("what should we do next", SPOKEN)).toBe(false);
  });

  it("keeps a long turn that happens to share words", () => {
    expect(
      isEchoOfSpeech(
        "I am not sure you are hearing me so let me say the whole thing again from the top",
        SPOKEN,
      ),
    ).toBe(false);
  });

  it("drops a looser overlap only at the playback threshold", () => {
    expect(isEchoOfSpeech("I am here what about that", SPOKEN)).toBe(false);
    expect(isEchoOfSpeech("I am here what about that", SPOKEN, 0.4)).toBe(true);
  });

  it("keeps everything when nothing was spoken", () => {
    expect(isEchoOfSpeech("I am here in", "")).toBe(false);
  });

  const NEWSPAPER = "Happy to, but I'm not sure which newspaper you mean";

  it("catches a 2-word echo that leads the spoken line", () => {
    expect(isEchoOfSpeech("happy to", NEWSPAPER)).toBe(true);
  });

  it("catches a 2-word echo adjacent mid-line", () => {
    expect(isEchoOfSpeech("tell me", "…just tell me the client…")).toBe(true);
  });

  it("catches a 2-word echo further in the line", () => {
    expect(isEchoOfSpeech("new project", "…tell me which new project you meant…")).toBe(true);
  });

  it("drops a 2-word pair that isn't adjacent in the line", () => {
    expect(isEchoOfSpeech("hello there", NEWSPAPER)).toBe(false);
  });

  it("keeps a single word, never an echo", () => {
    expect(isEchoOfSpeech("yes", NEWSPAPER)).toBe(false);
  });

  it("drops a 2-word pair that only appears non-adjacently", () => {
    expect(isEchoOfSpeech("happy sure", NEWSPAPER)).toBe(false);
  });

  it("catches a longer verbatim or slightly garbled echo inside one reply", () => {
    const reply =
      "I checked the staging deploy logs for your service and all thirty two integration tests passed without errors today";
    expect(
      isEchoOfSpeech(
        "uh checked the staging deploy logs for your service and thirty two integration tests passed",
        reply,
      ),
    ).toBe(true);
  });

  it("keeps a genuine long turn whose shared words are scattered across distant turns", () => {
    const history = [
      "I checked the weather forecast for tomorrow morning in Tokyo.",
      "Please wait a moment while we look into your calendar details.",
      "You should bring an umbrella if you plan to walk outside.",
      "And the train schedule looks clear for the afternoon commute.",
    ].join(" ");
    expect(
      isEchoOfSpeech(
        "I checked if tomorrow in Tokyo you should bring an umbrella for the afternoon commute anyway",
        history,
      ),
    ).toBe(false);
  });

  it("keeps long playback interruptions at the looser barge-in threshold", () => {
    const reply =
      "I checked the staging deploy logs for your service and all thirty two integration tests passed today";
    expect(
      isEchoOfSpeech(
        "stop please I checked the logs already let us deploy something completely different instead",
        reply,
        0.4,
      ),
    ).toBe(false);
  });

  it("handles repetitive long transcripts and replies without stalling", () => {
    const repeatedReply = Array.from({ length: 150 }, (_, i) =>
      i % 2 === 0 ? "yeah" : "okay",
    ).join(" ");
    const repeatedHeard = `${Array.from({ length: 75 }, () => "yeah").join(" ")} ${Array.from(
      { length: 75 },
      () => "wait",
    ).join(" ")}`;
    expect(isEchoOfSpeech(repeatedHeard, repeatedReply)).toBe(false);

    const fiveMinuteClip = Array.from({ length: 500 }, () => "yeah").join(" ");
    expect(isEchoOfSpeech(fiveMinuteClip, fiveMinuteClip)).toBe(false);
  });
});

describe("SpokenMemory", () => {
  it("catches an echo of a reply the bot has already spoken past", () => {
    const memory = new SpokenMemory();
    memory.remember(SPOKEN, 0);
    memory.remember("Booked for Friday", 1_000);

    expect(memory.isEcho("hey I am here and here", undefined, 2_000)).toBe(true);
  });

  it("catches a line the mic heard across two spoken sentences", () => {
    const memory = new SpokenMemory();
    memory.remember("Okay, give me a second", 0);
    memory.remember("I am checking the deploy now", 500);

    expect(memory.isEcho("a second I am checking", undefined, 1_000)).toBe(true);
  });

  it("forgets what was spoken more than the window ago", () => {
    const memory = new SpokenMemory();
    memory.remember(SPOKEN, 0);

    expect(memory.isEcho("hey I am here and here", undefined, 14_000)).toBe(true);
    expect(memory.isEcho("hey I am here and here", undefined, 16_000)).toBe(false);
  });

  it("refreshes the echo window when the same reply is remembered again after playback", () => {
    const memory = new SpokenMemory();
    memory.remember(SPOKEN, 0);
    memory.remember(SPOKEN, 20_000);

    expect(memory.isEcho("hey I am here and here", undefined, 30_000)).toBe(true);
    expect(memory.isEcho("hey I am here and here", undefined, 36_000)).toBe(false);
  });

  it("does not merge two separate replies to reject a genuine long turn", () => {
    const memory = new SpokenMemory();
    memory.remember("Please check the staging server status right now", 0);
    memory.remember("before we restart the background worker queue", 1_000);

    expect(
      memory.isEcho(
        "Please check the staging server status and wait before we restart the background worker queue today",
        undefined,
        2_000,
      ),
    ).toBe(false);
  });

  it("keeps a genuine turn, and everything once cleared", () => {
    const memory = new SpokenMemory();
    memory.remember(SPOKEN, 0);

    expect(memory.isEcho("what should we do next", undefined, 100)).toBe(false);
    memory.clear();
    expect(memory.isEcho("hey I am here and here", undefined, 100)).toBe(false);
  });
});
