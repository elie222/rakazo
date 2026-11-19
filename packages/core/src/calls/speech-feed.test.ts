import { describe, expect, it } from "vitest";
import type { Deferred } from "../primitives/async.test-support.js";
import { deferred } from "../primitives/async.test-support.js";
import type { SpeechFeedVoice } from "./speech-feed.js";
import { createSpeechFeed } from "./speech-feed.js";

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

/** A voice whose every step waits for the test. */
function fakeVoice() {
  const prepared = new Map<string, Deferred<readonly string[]>>();
  const rendered = new Map<string, Deferred<string>>();
  const playing: { utterance: string; done: Deferred<void>; signal: AbortSignal }[] = [];
  const voice: SpeechFeedVoice<string> = {
    prepare: (text) => {
      const step = deferred<readonly string[]>();
      prepared.set(text, step);
      return step.promise;
    },
    render: (utterance) => {
      const step = deferred<string>();
      rendered.set(utterance, step);
      return step.promise;
    },
    play: (clip, utterance, signal) => {
      expect(clip).toBe(`clip:${utterance}`);
      const done = deferred<void>();
      signal.addEventListener("abort", () => done.resolve());
      playing.push({ utterance, done, signal });
      return done.promise;
    },
  };
  return {
    voice,
    prepared,
    rendered,
    playing,
    /** Every clip asked for renders at once. */
    renderAll: () => {
      for (const [utterance, step] of rendered) step.resolve(`clip:${utterance}`);
    },
    played: () => playing.map((play) => play.utterance),
    finishPlaying: () => playing.at(-1)?.done.resolve(),
  };
}

function settled(promise: Promise<void>) {
  const state = { value: "pending" as "pending" | "said" | "failed", error: undefined as unknown };
  promise.then(
    () => {
      state.value = "said";
    },
    (error: unknown) => {
      state.value = "failed";
      state.error = error;
    },
  );
  return state;
}

describe("createSpeechFeed", () => {
  it("says pushes in push order, however their preparing finishes", async () => {
    const fake = fakeVoice();
    const feed = createSpeechFeed(fake.voice);
    const first = settled(feed.push("Hello. Again."));
    const second = settled(feed.push("Bye."));
    fake.prepared.get("Bye.")?.resolve(["Bye."]);
    await flush();
    expect(fake.rendered.size).toBe(0);
    fake.prepared.get("Hello. Again.")?.resolve(["Hello.", "Again."]);
    await flush();
    fake.renderAll();
    await flush();
    expect(fake.played()).toEqual(["Hello."]);

    fake.finishPlaying();
    await flush();
    fake.renderAll();
    await flush();
    expect(fake.played()).toEqual(["Hello.", "Again."]);
    expect(first.value).toBe("pending");

    fake.finishPlaying();
    await flush();
    expect(first.value).toBe("said");
    fake.renderAll();
    await flush();
    expect(fake.played()).toEqual(["Hello.", "Again.", "Bye."]);
    expect(second.value).toBe("pending");
    fake.finishPlaying();
    await flush();
    expect(second.value).toBe("said");
  });

  it("renders the next clip while one plays, from one push into the next, and no further", async () => {
    const fake = fakeVoice();
    const feed = createSpeechFeed(fake.voice);
    void feed.push("One.");
    fake.prepared.get("One.")?.resolve(["One."]);
    await flush();
    fake.renderAll();
    await flush();
    expect(fake.played()).toEqual(["One."]);

    void feed.push("Two. Three.");
    fake.prepared.get("Two. Three.")?.resolve(["Two.", "Three."]);
    await flush();
    // "Two." renders while "One." still plays; "Three." waits for its turn.
    expect([...fake.rendered.keys()]).toEqual(["One.", "Two."]);

    fake.renderAll();
    fake.finishPlaying();
    await flush();
    expect(fake.played()).toEqual(["One.", "Two."]);
    expect([...fake.rendered.keys()]).toEqual(["One.", "Two.", "Three."]);
  });

  it("plays text pushed after everything before it was said", async () => {
    const fake = fakeVoice();
    const feed = createSpeechFeed(fake.voice);
    const first = settled(feed.push("One."));
    fake.prepared.get("One.")?.resolve(["One."]);
    await flush();
    fake.renderAll();
    await flush();
    fake.finishPlaying();
    await flush();
    expect(first.value).toBe("said");

    const second = settled(feed.push("Two."));
    fake.prepared.get("Two.")?.resolve(["Two."]);
    await flush();
    fake.renderAll();
    await flush();
    expect(fake.played()).toEqual(["One.", "Two."]);
    fake.finishPlaying();
    await flush();
    expect(second.value).toBe("said");
  });

  it("stops playing at once and settles every push without an error", async () => {
    const fake = fakeVoice();
    const feed = createSpeechFeed(fake.voice);
    const first = settled(feed.push("One."));
    const second = settled(feed.push("Two."));
    fake.prepared.get("One.")?.resolve(["One."]);
    await flush();
    fake.renderAll();
    await flush();

    feed.stop();
    await flush();
    expect(fake.playing[0]?.signal.aborted).toBe(true);
    expect(first.value).toBe("said");
    expect(second.value).toBe("said");
    expect(feed.stopped).toBe(true);

    fake.prepared.get("Two.")?.resolve(["Two."]);
    await feed.push("Three.");
    await flush();
    expect(fake.played()).toEqual(["One."]);
    expect(fake.prepared.has("Three.")).toBe(false);
  });

  it("says what came before a text it cannot prepare, then fails every push left", async () => {
    const fake = fakeVoice();
    const feed = createSpeechFeed(fake.voice);
    const first = settled(feed.push("One."));
    const second = settled(feed.push("Two."));
    const third = settled(feed.push("Three."));
    const failure = new Error("no voice");
    fake.prepared.get("Two.")?.reject(failure);
    fake.prepared.get("One.")?.resolve(["One."]);
    await flush();
    fake.renderAll();
    await flush();
    expect(fake.played()).toEqual(["One."]);
    expect(first.value).toBe("pending");

    fake.finishPlaying();
    await flush();
    expect(first.value).toBe("said");
    expect(second).toEqual({ value: "failed", error: failure });
    expect(third).toEqual({ value: "failed", error: failure });
    expect(feed.stopped).toBe(true);
  });

  it("fails when a clip cannot render or play", async () => {
    const fake = fakeVoice();
    const feed = createSpeechFeed(fake.voice);
    const rendering = settled(feed.push("One."));
    fake.prepared.get("One.")?.resolve(["One."]);
    await flush();
    fake.rendered.get("One.")?.reject(new Error("render failed"));
    await flush();
    expect(rendering.value).toBe("failed");

    const playback = createSpeechFeed<string>({
      ...fake.voice,
      prepare: async (text) => [text],
      render: async (utterance) => `clip:${utterance}`,
      play: async () => {
        throw new Error("cannot play");
      },
    });
    await expect(playback.push("Two.")).rejects.toThrow("cannot play");
  });
});
