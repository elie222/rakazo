import type { MessageBlock } from "@rakazo/contracts";
import { progressMessageId } from "../messages/events.js";
import { sentenceKey, splitSentences } from "./speech-text.js";

/**
 * How much of a reply a call says while the run still writes it. Call replies are a few short
 * sentences; anything longer waits for the finished reply.
 */
export const CALL_STREAM_MAX_CHARS = 300;

type CallMessage = {
  id: string;
  role?: string;
  runId?: string;
  blocks: readonly MessageBlock[];
};

type Reply = {
  runId: string;
  /** The run's messages from before this reply started: they are not part of it. */
  before: Set<string>;
  /** The server marked the run's live text as shown: it is the reply, not private work. */
  shown: boolean;
  /** Each message the live text turned into, with the sentences said of it, in order. */
  saidOf: Map<string, string[]>;
  /** The sentences said of the live text since it last turned into a message, in order. */
  said: string[];
  /** Every sentence of the live text as last seen, to know the message it turns into. */
  written: string[];
  chars: number;
  /** Nothing more is said until the reply is finished: over budget, or the caller cut in. */
  held: boolean;
  /** The sentence the caller cut off, as written so far: its finished form was heard too. */
  cutOff?: string;
};

/**
 * Speaks a call's reply as its run writes it: the finished sentences of the run's live message,
 * the end of any text the run posts as a message before a step, then what the finished reply
 * adds. One reply at a time; each sentence the run writes is said once.
 */
export function createCallReplySpeech() {
  let reply: Reply | null = null;

  const replyFor = (runId: string, messages: readonly CallMessage[]): Reply => {
    if (reply?.runId !== runId) {
      reply = {
        runId,
        before: new Set(messages.filter((m) => m.runId === runId).map((m) => m.id)),
        shown: false,
        saidOf: new Map(),
        said: [],
        written: [],
        chars: 0,
        held: false,
      };
    }
    return reply;
  };

  /** Says the sentences in order, recording each in `into`, until the budget runs out. */
  const say = (current: Reply, sentences: readonly string[], into: string[]): string[] => {
    const fresh: string[] = [];
    for (const sentence of sentences) {
      if (current.held) break;
      // The first sentence over budget holds the rest back, so they are said in order.
      if (current.chars + sentence.length > CALL_STREAM_MAX_CHARS) {
        current.held = true;
        break;
      }
      current.chars += sentence.length;
      into.push(sentenceKey(sentence));
      fresh.push(sentence);
    }
    return fresh;
  };

  /**
   * Text the run wrote before a step and then posted as a message: it begins like the live text
   * it replaced. Messages the run posts any other way are not the reply being said.
   */
  const isNarration = (current: Reply, message: CallMessage) =>
    message.runId === current.runId &&
    message.role === "bot" &&
    !current.before.has(message.id) &&
    !current.saidOf.has(message.id) &&
    current.written.length > 0 &&
    keysOf(textSentences(message.blocks))[0] === current.written[0];

  /** The live text became this message: what it had not said yet is finished now. */
  const takeOver = (current: Reply, message: CallMessage, heardAll: boolean): string[] => {
    const sentences = textSentences(message.blocks);
    const said = current.said.slice(0, agreed(keysOf(sentences), current.said));
    current.saidOf.set(message.id, said);
    current.said = [];
    current.written = [];
    const rest = sentences.slice(said.length);
    if (!heardAll) return say(current, rest, said);
    said.push(...keysOf(rest));
    return [];
  };

  return {
    /**
     * The finished sentences the run wrote since the last take, or "" for none. Taking again
     * without new text returns "". Text the server did not mark as shown is never taken.
     */
    take(messages: readonly CallMessage[], runId: string): string {
      const current = replyFor(runId, messages);
      const liveIndex = liveMessageIndex(messages, runId);
      const live = messages[liveIndex];
      if (!live) return "";
      current.shown ||= live.blocks.some((block) => block.kind === "progress" && block.shown);
      if (!current.shown) return "";
      const fresh: string[] = [];
      // A message before the live one replaced the text the run wrote before its step.
      for (const message of messages.slice(0, liveIndex)) {
        if (isNarration(current, message)) fresh.push(...takeOver(current, message, false));
      }
      const settled = liveSentences(live.blocks, false);
      const written = liveSentences(live.blocks, true);
      if (written.length > 0) current.written = keysOf(written);
      // A reset or a retried attempt rewrites the live text: keep what it still agrees on.
      const keys = keysOf(settled);
      const kept = agreed(keys, current.said);
      if (kept < current.said.length && kept < keys.length) current.said.length = kept;
      fresh.push(...say(current, settled.slice(current.said.length), current.said));
      return fresh.join(" ");
    },

    /**
     * The caller cut in: everything the run has written so far counts as heard, even the
     * sentence still being written, and nothing more is taken until the reply is finished.
     */
    seal(messages: readonly CallMessage[], runId: string): void {
      const current = reply;
      if (current?.runId !== runId) return;
      for (const message of messages) {
        if (isNarration(current, message)) takeOver(current, message, true);
      }
      const live = messages[liveMessageIndex(messages, runId)];
      if (live) {
        current.said = keysOf(liveSentences(live.blocks, false));
        const tail = live.blocks.at(-1);
        if (tail?.kind === "progress" && tail.shown) {
          current.cutOff = keysOf(sentencesOf(tail.text)).at(-1);
        }
      }
      current.held = true;
    },

    /**
     * What is left to say of the run's finished reply. The sentences already said of the text it
     * came from are found where they start in it and skipped in order, past single sentences
     * written differently (a redaction), added (a step label) or left out between them; whatever
     * follows is said. The text comes back unchanged when none was said. Ends the reply.
     */
    finish(runId: string, text: string, messageId?: string): string {
      if (reply?.runId !== runId) return text;
      const current = reply;
      reply = null;
      const ownSaid = messageId ? current.saidOf.get(messageId) : undefined;
      const said = ownSaid ?? current.said;
      const cutOff = ownSaid ? undefined : current.cutOff;
      const sentences = sentencesOf(text);
      const keys = keysOf(sentences);
      const start =
        said.length > 0 ? keys.findIndex((key) => key === said[0] || key === said[1]) : -1;
      if (start < 0) return text;
      let index = start;
      let matched = 0;
      while (index < keys.length && matched < said.length) {
        const next = matched + 1 < said.length ? said[matched + 1] : undefined;
        if (keys[index] === said[matched]) {
          index += 1;
          matched += 1;
        } else if (keys[index + 1] === said[matched]) {
          index += 1;
        } else if (next !== undefined && keys[index] === next) {
          matched += 1;
        } else if (next !== undefined && keys[index + 1] === next) {
          index += 1;
          matched += 1;
        } else break;
      }
      // The sentence cut off right after them was heard as far as it went.
      if (matched === said.length && cutOff && keys[index]?.startsWith(cutOff)) index += 1;
      return sentences.slice(index).join(" ");
    },

    /**
     * Saying the reply failed, so what was taken may not have been heard: nothing more is
     * taken, and the finished reply is said whole.
     */
    forget(runId: string): void {
      const current = reply;
      if (current?.runId !== runId) return;
      current.said = [];
      current.saidOf.clear();
      current.cutOff = undefined;
      current.held = true;
    },

    clear(): void {
      reply = null;
    },
  };
}

function liveMessageIndex(messages: readonly CallMessage[], runId: string): number {
  const id = progressMessageId({ runId });
  return messages.findLastIndex((message) => message.id === id);
}

/** Sentences that say something; punctuation alone is nothing to say or match. */
function sentencesOf(text: string): string[] {
  return splitSentences(text).filter((sentence) => sentenceKey(sentence));
}

function keysOf(sentences: readonly string[]): string[] {
  return sentences.map(sentenceKey);
}

/** How many leading sentences two texts share. */
function agreed(keys: readonly string[], said: readonly string[]): number {
  let count = 0;
  while (count < keys.length && count < said.length && keys[count] === said[count]) count += 1;
  return count;
}

function textSentences(blocks: readonly MessageBlock[]): string[] {
  return sentencesOf(
    blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("\n"),
  );
}

/**
 * The live message as sentences: text that ended before a step, then the shown text still
 * streaming, whose last sentence may still grow unless the whole of it is wanted.
 */
function liveSentences(blocks: readonly MessageBlock[], whole: boolean): string[] {
  const sentences: string[] = [];
  for (const block of blocks) {
    if (block.kind === "text") sentences.push(...sentencesOf(block.text));
    else if (block.kind === "progress" && block.shown) {
      const streaming = sentencesOf(block.text);
      sentences.push(...(whole ? streaming : streaming.slice(0, -1)));
    }
  }
  return sentences;
}
