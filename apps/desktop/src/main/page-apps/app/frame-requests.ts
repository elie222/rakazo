import type { PageState } from "@rakazo/contracts";
import { PAGE_NOTIFY_BODY_MAX_LENGTH, PAGE_NOTIFY_TITLE_MAX_LENGTH } from "@rakazo/contracts";
import { pageAskRequest, pageCopyRequest, pageLinkRequest, pageStateRequest } from "@rakazo/core";

/** What the page in the frame asked its app for, once it has been checked. */
export type FrameRequest =
  | { kind: "state"; values: PageState }
  | { kind: "open-link"; url: string }
  | { kind: "copy"; id: string; text: string }
  | { kind: "ask"; id: string; text: string }
  | { kind: "notify"; title: string; body: string };

function line(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= max ? text : null;
}

/** The frame is untrusted: anything not exactly one of these is dropped. */
export function frameRequest(data: unknown): FrameRequest | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  switch (message.type) {
    case "rakazo-page:state": {
      const values = pageStateRequest(data);
      return values ? { kind: "state", values } : null;
    }
    case "rakazo-page:open-link": {
      const url = pageLinkRequest(data);
      return url ? { kind: "open-link", url } : null;
    }
    case "rakazo-page:copy": {
      const copy = pageCopyRequest(data);
      return copy ? { kind: "copy", ...copy } : null;
    }
    case "rakazo-page:ask": {
      const ask = pageAskRequest(data);
      return ask ? { kind: "ask", ...ask } : null;
    }
    case "rakazo-page:notify": {
      const title = line(message.title, PAGE_NOTIFY_TITLE_MAX_LENGTH);
      const body =
        message.body === undefined ? "" : line(message.body, PAGE_NOTIFY_BODY_MAX_LENGTH);
      return title && body !== null ? { kind: "notify", title, body } : null;
    }
    default:
      return null;
  }
}

/** Whether a notification may show now: at most one per interval, so a page cannot flood. */
export function createRateLimit(intervalMs: number, now: () => number = Date.now) {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const time = now();
    if (time - last < intervalMs) return false;
    last = time;
    return true;
  };
}
