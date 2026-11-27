import {
  PAGE_ASK_MAX_LENGTH,
  PAGE_NOTIFY_BODY_MAX_LENGTH,
  PAGE_NOTIFY_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";

const ASK_MESSAGE = "rakazo-page:ask";
const ANSWER_MESSAGE = "rakazo-page:answer";
const NOTIFY_MESSAGE = "rakazo-page:notify";

// Unique to this document, so an answer meant for the page before a reload never resolves a
// question this one asks.
const DOCUMENT_KEY = Math.random().toString(36).slice(2, 10);
let asks = 0;

/** Only hosts that can send a question into the page's chat mark the document. */
function askAvailable(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-ask");
}

/**
 * Asks the page's bot in its chat, as the reader, and resolves with the text of its reply. The
 * host sends one question per click or key in the page and answers every one it receives.
 */
export function askBot(question: unknown): Promise<string> {
  const text = typeof question === "string" ? question.trim() : "";
  if (!text || text.length > PAGE_ASK_MAX_LENGTH)
    return Promise.reject(new Error(`askBot takes 1 to ${PAGE_ASK_MAX_LENGTH} characters.`));
  if (!askAvailable()) return Promise.reject(new Error("The bot can't be asked from here."));
  asks += 1;
  const id = `ask-${DOCUMENT_KEY}-${asks}`;
  return new Promise((resolve, reject) => {
    function answer(event: MessageEvent) {
      const data = event.data as { type?: unknown; id?: unknown; ok?: unknown; text?: unknown };
      if (data?.type !== ANSWER_MESSAGE || data.id !== id) return;
      window.removeEventListener("message", answer);
      if (data.ok === true && typeof data.text === "string") resolve(data.text);
      else reject(new Error("The bot couldn't answer."));
    }
    window.addEventListener("message", answer);
    window.parent?.postMessage({ type: ASK_MESSAGE, id, text }, "*");
  });
}

/** A system notification where the page runs as an installed app; other hosts ignore it. */
export function notify(title: unknown, body?: unknown): void {
  const heading = typeof title === "string" ? title.trim() : "";
  if (!heading || heading.length > PAGE_NOTIFY_TITLE_MAX_LENGTH) return;
  const detail = typeof body === "string" ? body.trim().slice(0, PAGE_NOTIFY_BODY_MAX_LENGTH) : "";
  window.parent?.postMessage(
    { type: NOTIFY_MESSAGE, title: heading, ...(detail ? { body: detail } : {}) },
    "*",
  );
}
