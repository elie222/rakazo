import { describe, expect, it } from "vitest";
import type { LiveThreadSnapshot, ThreadSnapshotEvent } from "../threads/thread-snapshot-events.js";
import { reduceThreadSnapshot } from "../threads/thread-snapshot-events.js";
import { CALL_STREAM_MAX_CHARS, createCallReplySpeech } from "./call-reply-speech.js";

const EMPTY: LiveThreadSnapshot = {
  threadId: "thread-1",
  olderCursor: null,
  messages: [],
  run: { id: "run-1", status: "running" },
};

function progress(payload: Record<string, unknown>, runId = "run-1"): ThreadSnapshotEvent {
  return { type: "thread.progress", botId: "bot-1", runId, payload };
}

/** The first flush of an attempt replaces the live text; later flushes add to it. */
const shownText = (text: string, runId?: string) =>
  progress({ text, streaming: true, shown: true }, runId);
const shownDelta = (delta: string) => progress({ delta, streaming: true, shown: true });
const tool = (name = "shell"): ThreadSnapshotEvent => ({
  type: "agent.tool.called",
  botId: "bot-1",
  runId: "run-1",
  payload: { name },
});
/** The note that replaces the text written before a step, as its working line. */
const note = (text: string) => progress({ reset: true, text, activity: true });

function botMessage(messageId: string, text: string): ThreadSnapshotEvent {
  return {
    type: "thread.message.created",
    botId: "bot-1",
    runId: "run-1",
    payload: { messageId, role: "bot", blocks: [{ kind: "text", text }] },
  };
}

/** A call's tracker fed the thread as the client's reducer builds it, one event at a time. */
function call(runId = "run-1", thread = EMPTY) {
  const speech = createCallReplySpeech();
  return {
    speech,
    get messages() {
      return thread.messages;
    },
    /** Applies each event and takes after it, as a call does; returns everything said. */
    hear(...events: ThreadSnapshotEvent[]) {
      const said: string[] = [];
      for (const event of [...events, undefined]) {
        if (event) thread = reduceThreadSnapshot(thread, event) ?? thread;
        const taken = speech.take(thread.messages, runId);
        if (taken) said.push(taken);
        if (!event) break;
      }
      return said.join(" ");
    },
  };
}

describe("createCallReplySpeech", () => {
  it("says each sentence once it is finished, whatever the batches cut it at", () => {
    const reply = call();
    expect(reply.hear(shownText("Booked for Fri"))).toBe("");
    expect(reply.hear(shownDelta("day. The ho"))).toBe("Booked for Friday.");
    expect(reply.hear(shownDelta("tel is near the station. "))).toBe("");
    expect(reply.hear(shownDelta("Any"))).toBe("The hotel is near the station.");
    // Taking again without new text says nothing.
    expect(reply.hear()).toBe("");
    expect(reply.speech.take(reply.messages, "run-1")).toBe("");
  });

  it("says nothing the server did not mark as shown, and leaves the final text as it is", () => {
    const reply = call();
    expect(
      reply.hear(
        progress({ text: "Booked for Friday. The hotel", streaming: true }),
        progress({ delta: " is close. Bye", streaming: true }),
        botMessage("interim-1", "Booked for Friday. The hotel is close."),
        tool(),
      ),
    ).toBe("");
    const final = "**Booked** for Friday. The hotel is close.";
    expect(reply.speech.finish("run-1", final, "message-1")).toBe(final);
  });

  it("never says tool status lines", () => {
    const reply = call();
    expect(
      reply.hear(progress({ text: "Searching the web. Reading a page.", activity: true })),
    ).toBe("");
  });

  it("says a sentence the reply repeats", () => {
    const reply = call();
    expect(reply.hear(shownText("Yes. Two rooms. Yes. And"))).toBe("Yes. Two rooms. Yes.");
  });

  it("says only what a retried attempt adds", () => {
    const reply = call();
    expect(reply.hear(shownText("Checking the logs. They"))).toBe("Checking the logs.");
    expect(reply.hear(shownText("Checking the logs. They look clean. Done"))).toBe(
      "They look clean.",
    );
  });

  describe("text written before a step", () => {
    it("says its last sentence once the run posts it as a message (server order)", () => {
      const reply = call();
      expect(
        reply.hear(
          shownText("Your flight leaves at nine. I will book"),
          shownDelta(" the taxi now."),
          botMessage("interim-1", "Your flight leaves at nine. I will book the taxi now."),
          tool(),
        ),
      ).toBe("Your flight leaves at nine. I will book the taxi now.");
      expect(
        reply.hear(shownText("The taxi is booked. It arrives at"), shownDelta(" eight.")),
      ).toBe("The taxi is booked.");
      expect(
        reply.speech.finish("run-1", "The taxi is booked. It arrives at eight.", "message-1"),
      ).toBe("It arrives at eight.");
    });

    it("says its last sentence on the note path too", () => {
      const reply = call();
      expect(
        reply.hear(
          shownText("Your flight leaves at nine. I will book the taxi now."),
          tool(),
          note("Your flight leaves at nine. I will book the taxi now."),
        ),
      ).toBe("Your flight leaves at nine. I will book the taxi now.");
      expect(reply.hear(shownText("The taxi is booked. It"))).toBe("The taxi is booked.");
    });

    it("says the whole of a message when nothing of it was finished yet", () => {
      const reply = call();
      expect(
        reply.hear(
          shownText("Let me check the weather."),
          botMessage("interim-1", "Let me check the weather."),
          tool("web_search"),
        ),
      ).toBe("Let me check the weather.");
    });

    it("says a sentence again when a later part of the reply repeats it", () => {
      const reply = call();
      expect(
        reply.hear(
          shownText("Sure. Opening"),
          botMessage("interim-1", "Sure. Opening the report."),
          tool(),
          shownText("Sure. Totals are in. March"),
        ),
      ).toBe("Sure. Opening the report. Sure. Totals are in.");
    });

    it("treats new text that starts like the text it replaced as a rewrite", () => {
      const reply = call();
      expect(reply.hear(shownText("Let me check. Done with A."), tool())).toBe(
        "Let me check. Done with A.",
      );
      expect(reply.hear(note("Done with A."), shownText("Let me check. It passed. And"))).toBe(
        "It passed.",
      );
    });

    it("ignores messages the run posted before the reply started, and ones it did not stream", () => {
      const reply = call("run-1", {
        ...EMPTY,
        messages: [
          { id: "earlier", role: "bot", runId: "run-1", blocks: [{ kind: "text", text: "Hi." }] },
        ],
      });
      expect(
        reply.hear(
          shownText("Hi. Working"),
          botMessage("update-1", "Still on it, about a minute."),
          tool(),
        ),
      ).toBe("Hi.");
    });

    it("leaves nothing of a message already said when it is the last the run wrote", () => {
      const reply = call();
      reply.hear(
        shownText("Your flight leaves at nine. I will book the taxi now."),
        botMessage("interim-1", "Your flight leaves at nine. I will book the taxi now."),
        tool(),
      );
      expect(
        reply.speech.finish(
          "run-1",
          "Your flight leaves at nine. I will book the taxi now.",
          "interim-1",
        ),
      ).toBe("");
    });
  });

  describe("the finished reply", () => {
    it("leaves only its unsaid end", () => {
      const reply = call();
      reply.hear(shownText("Booked for Friday. The hotel is near"));
      expect(
        reply.speech.finish("run-1", "Booked for Friday.\n\nThe hotel is near the station."),
      ).toBe("The hotel is near the station.");
    });

    it("says nothing more when it is what was said", () => {
      const reply = call();
      reply.hear(shownText("Booked for Friday. All set. "), shownDelta("Bye"));
      expect(reply.speech.finish("run-1", "**Booked** for Friday. All set.")).toBe("");
    });

    it("adds notes it carries past what was said", () => {
      const reply = call();
      reply.hear(shownText("Booked for Friday. All set"));
      expect(
        reply.speech.finish("run-1", "Booked for Friday. All set.\n\nI also saved the receipt."),
      ).toBe("All set. I also saved the receipt.");
    });

    it("says what follows the text said in this part, even a sentence said in an earlier part", () => {
      const reply = call();
      reply.hear(
        shownText("Checking. Done. "),
        botMessage("interim-1", "Checking. Done."),
        tool(),
        shownText("I booked the room. The invite is sent"),
      );
      expect(
        reply.speech.finish("run-1", "I booked the room. The invite is sent. Done.", "message-1"),
      ).toBe("The invite is sent. Done.");
    });

    it("skips a sentence written differently, and a step label, without going back", () => {
      const reply = call();
      reply.hear(shownText("Saved the key [redacted]. All set. Any"));
      expect(reply.speech.finish("run-1", "Saved the key ••••. All set. Anything else?")).toBe(
        "Anything else?",
      );
      const labelled = call();
      labelled.hear(shownText("Found it. "), tool(), shownText("Found it. It is sunny. Any"));
      expect(
        labelled.speech.finish("run-1", "Found it.\nWeb search\nIt is sunny. Anything else?"),
      ).toBe("Anything else?");
    });

    it("says a question the run stops on in full, and the resumed run from the start", () => {
      const reply = call();
      expect(reply.hear(shownText("I need one thing. Which"))).toBe("I need one thing.");
      expect(reply.speech.finish("run-1", "Which account should I use?")).toBe(
        "Which account should I use?",
      );
      expect(reply.hear(shownText("Using the work account. I need one thing. More"))).toBe(
        "Using the work account. I need one thing.",
      );
    });

    it("is said whole after saying part of it failed, and nothing more is taken first", () => {
      const reply = call();
      expect(reply.hear(shownText("Booked for Friday. The ho"))).toBe("Booked for Friday.");
      reply.speech.forget("run-1");
      expect(reply.hear(shownDelta("tel is close. Any"))).toBe("");
      expect(
        reply.speech.finish("run-1", "Booked for Friday. The hotel is close. Anything else?"),
      ).toBe("Booked for Friday. The hotel is close. Anything else?");
    });

    it("finishes another run's reply without touching this one", () => {
      const reply = call();
      reply.hear(shownText("Booked for Friday. The"));
      expect(reply.speech.finish("run-0", "Earlier reply.")).toBe("Earlier reply.");
      expect(reply.hear(shownDelta(" hotel is close. Bye"))).toBe("The hotel is close.");
    });
  });

  it("holds the rest back past the budget, then says it once the reply is finished", () => {
    const reply = call();
    const long = `${"word ".repeat(CALL_STREAM_MAX_CHARS / 10).trim()}.`;
    expect(reply.hear(shownText(`Short one. ${long} ${long} After`))).toBe(`Short one. ${long}`);
    expect(reply.hear(shownDelta(" that. Then"))).toBe("");
    expect(
      reply.speech.finish("run-1", `Short one. ${long} ${long} After that. Then the end.`),
    ).toBe(`${long} After that. Then the end.`);
  });

  describe("a cut-in", () => {
    it("stops taking, counting the sentence cut off as heard", () => {
      const reply = call();
      expect(reply.hear(shownText("First point. Second po"))).toBe("First point.");
      reply.speech.seal(reply.messages, "run-1");
      expect(reply.hear(shownDelta("int is longer. Third"))).toBe("");
      expect(
        reply.speech.finish(
          "run-1",
          "First point. Second point is longer. Third. About your question.",
        ),
      ).toBe("Third. About your question.");
    });

    it("matches the cut-off sentence only right after the text said before it", () => {
      const reply = call();
      reply.hear(shownText("First point. The"));
      reply.speech.seal(reply.messages, "run-1");
      const final = "Good question. The deploy shipped at noon. Anything else?";
      expect(reply.speech.finish("run-1", final, "message-1")).toBe(final);
    });

    it("lets a continuation run stream from the start", () => {
      const reply = call();
      reply.hear(shownText("First point. Second"));
      reply.speech.seal(reply.messages, "run-1");
      reply.hear(shownText("First point. Next", "run-2"));
      expect(reply.speech.take(reply.messages, "run-2")).toBe("First point.");
    });
  });
});
