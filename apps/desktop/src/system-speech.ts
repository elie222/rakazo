import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RakazoDesktopSpeechEvent } from "@rakazo/contracts";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { AppTarget } from "./app-frame.js";
import { fromAppFrame } from "./app-frame.js";

export const SPEECH_EVENT_CHANNEL = "desktop.speech.event";

/** Language tags only: the value becomes the recognizer's argument. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
/** The Web Speech codes the page handles; the recognizer may report no others. */
const ERROR_CODES = new Set([
  "aborted",
  "audio-capture",
  "language-not-supported",
  "network",
  "no-speech",
  "not-allowed",
  "service-not-allowed",
]);
const MAX_LINE_CHARS = 64 * 1024;

type InvokeEvent = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">;
type Listening = {
  sender: WebContents;
  session: number;
  child: ChildProcessWithoutNullStreams;
  cancel: () => void;
};

/**
 * One system recognizer at a time, for the app window only. Its JSON lines become
 * `desktop.speech.event` messages tagged with the page's session, and every session
 * ends with `end`, even when the recognizer cannot start or dies.
 */
export function createSystemSpeech(
  getTarget: () => AppTarget | null,
  spawnRecognizer: (language: string) => ChildProcessWithoutNullStreams,
) {
  let active: Listening | null = null;
  // Calls restart the recognizer at every pause, so each window is watched once, not per session.
  const watched = new WeakSet<WebContents>();

  const owner = (event: InvokeEvent, session: unknown) =>
    active !== null &&
    active.session === session &&
    active.sender === event.sender &&
    fromAppFrame(getTarget(), event)
      ? active
      : null;

  /** A page that is gone gets no more events; a replaced or aborted session still ends. */
  function close(listening: Listening, pageGone = false) {
    if (active === listening) active = null;
    if (pageGone) listening.cancel();
    listening.child.kill();
  }

  return {
    start(event: InvokeEvent, language: unknown, session: unknown): boolean {
      if (
        !fromAppFrame(getTarget(), event) ||
        typeof language !== "string" ||
        language.length > 35 ||
        !LANGUAGE_TAG.test(language) ||
        !Number.isSafeInteger(session) ||
        (session as number) <= 0
      )
        return false;
      if (active) close(active);
      const sender = event.sender;
      const send = (message: RakazoDesktopSpeechEvent) => {
        if (!ended && !sender.isDestroyed()) sender.send(SPEECH_EVENT_CHANNEL, message);
      };
      let ended = false;
      const end = (error?: string) => {
        if (ended) return;
        if (error) send({ session: session as number, type: "error", error });
        send({ session: session as number, type: "end" });
        ended = true;
        if (active?.child === child) active = null;
      };
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnRecognizer(language);
      } catch {
        // Reported after the page learns the session started, like a recognizer failure.
        setImmediate(() => end("service-not-allowed"));
        return true;
      }
      const listening: Listening = {
        sender,
        session: session as number,
        child,
        cancel: () => {
          ended = true;
        },
      };
      active = listening;
      if (!watched.has(sender)) {
        watched.add(sender);
        sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
          if (isMainFrame && !isInPlace && active?.sender === sender) close(active, true);
        });
        sender.once("destroyed", () => {
          if (active?.sender === sender) close(active, true);
        });
      }

      let pending = "";
      const read = (line: string) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof message !== "object" || message === null) return;
        const { type, text, error } = message as Record<string, unknown>;
        if (type === "result" && typeof text === "string") {
          send({ session: session as number, type: "result", text });
        } else if (type === "error" && typeof error === "string" && ERROR_CODES.has(error)) {
          send({ session: session as number, type: "error", error });
        } else if (type === "end") {
          end();
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (ended || active !== listening) return;
        pending += chunk;
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          if (newline > MAX_LINE_CHARS) break;
          read(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (ended || active !== listening) return;
          newline = pending.indexOf("\n");
        }
        if (pending.length > MAX_LINE_CHARS) {
          pending = "";
          end("network");
          close(listening);
        }
      });
      // Diagnostics only; an unread pipe would eventually block the recognizer.
      child.stderr.resume();
      child.stdin.on("error", () => undefined);
      // A missing or unlaunchable recognizer: the page falls back as if the service refused.
      child.on("error", () => end("service-not-allowed"));
      child.on("close", () => end());
      return true;
    },

    stop(event: InvokeEvent, session: unknown) {
      owner(event, session)?.child.stdin.write("stop\n");
    },

    abort(event: InvokeEvent, session: unknown) {
      const listening = owner(event, session);
      if (listening) close(listening);
    },
  };
}
