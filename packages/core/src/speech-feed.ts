/**
 * What a speech feed needs from a voice. A hosted voice renders audio for each utterance;
 * the device voice can use the utterance itself as its clip.
 */
export type SpeechFeedVoice<Clip> = {
  /** The utterances a text is spoken as. */
  prepare(text: string, signal: AbortSignal): Promise<readonly string[]>;
  render(utterance: string, signal: AbortSignal): Promise<Clip>;
  /** Plays one clip to its end, or until `signal` aborts; rejects when it cannot play. */
  play(clip: Clip, utterance: string, signal: AbortSignal): Promise<void>;
};

export type SpeechFeed = {
  /**
   * Says `text` after everything pushed before it. Settles once it has been said or the feed
   * was stopped, and rejects with the failure that stopped the feed.
   */
  push(text: string): Promise<void>;
  /** Cuts playback off and drops everything still waiting. */
  stop(): void;
  /** Stopped or failed: it says nothing more. */
  readonly stopped: boolean;
};

type Outcome<T> = { value: T } | { error: unknown };

type Item<Clip> =
  | { utterance: string; clip?: Promise<Outcome<Clip>> }
  /** Everything one push asked for has been said. */
  | { said: () => void }
  /** A push that could not be prepared: the feed fails once playback reaches it. */
  | { error: unknown };

/**
 * Says texts in the order they are pushed, as one stream. Each text is prepared as soon as it
 * is pushed, and the next clip renders while the current one plays, from one text into the
 * next too, so a reply pushed sentence by sentence plays without gaps.
 */
export function createSpeechFeed<Clip>(voice: SpeechFeedVoice<Clip>): SpeechFeed {
  const controller = new AbortController();
  const { signal } = controller;
  const items: Item<Clip>[] = [];
  const unsettled = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  /** Pushes still preparing. Their items are added in push order. */
  let preparing = 0;
  let inOrder: Promise<void> = Promise.resolve();
  let running = false;
  let wake: (() => void) | null = null;

  const render = (utterance: string) => attempt(() => voice.render(utterance, signal));

  /** Renders the clip playing now and the one after it, never further ahead. */
  const renderAhead = () => {
    let ahead = 0;
    for (const item of items) {
      if (!("utterance" in item)) continue;
      item.clip ??= render(item.utterance);
      ahead += 1;
      if (ahead === 2) return;
    }
  };

  const end = (failure?: { error: unknown }) => {
    controller.abort();
    items.length = 0;
    for (const push of unsettled) {
      if (failure) push.reject(failure.error);
      else push.resolve();
    }
    unsettled.clear();
    wake?.();
  };

  const run = async () => {
    running = true;
    try {
      while (!signal.aborted) {
        const item = items[0];
        if (!item) {
          if (preparing === 0) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          continue;
        }
        if ("said" in item) {
          items.shift();
          item.said();
          continue;
        }
        if ("error" in item) {
          end(item);
          return;
        }
        item.clip ??= render(item.utterance);
        renderAhead();
        const clip = await item.clip;
        if (signal.aborted) return;
        if ("error" in clip) {
          end(clip);
          return;
        }
        try {
          await voice.play(clip.value, item.utterance, signal);
        } catch (error) {
          if (!signal.aborted) end({ error });
          return;
        }
        items.shift();
      }
    } finally {
      running = false;
    }
  };

  return {
    push(text) {
      if (signal.aborted) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const pending = { resolve, reject };
        unsettled.add(pending);
        preparing += 1;
        const prepared = attempt(() => voice.prepare(text, signal));
        inOrder = inOrder.then(async () => {
          const utterances = await prepared;
          preparing -= 1;
          if (signal.aborted) return;
          if ("error" in utterances) items.push(utterances);
          else {
            for (const utterance of utterances.value) items.push({ utterance });
            items.push({
              said: () => {
                unsettled.delete(pending);
                resolve();
              },
            });
          }
          renderAhead();
          wake?.();
        });
        if (!running) void run();
      });
    },
    stop() {
      if (!signal.aborted) end();
    },
    get stopped() {
      return signal.aborted;
    },
  };
}

function attempt<T>(start: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return start().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  } catch (error) {
    return Promise.resolve({ error });
  }
}
