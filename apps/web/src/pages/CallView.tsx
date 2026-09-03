import { Trans, useLingui } from "@lingui/react/macro";
import type { ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { isSecretAskBlock, narrateTool, speechFromBlocks, spokenDecision } from "@rakazo/core";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { dictation } from "../lib/dictation";
import { speaker } from "../lib/tts";

type Phase = "listening" | "thinking" | "speaking";

export function CallView({
  botId,
  botName,
  transcribe,
  snapshot,
  onSend,
  onFollowUp,
  onAnswer,
  onClose,
}: {
  botId: string;
  botName: string;
  transcribe: boolean;
  snapshot: ThreadSnapshot | null;
  onSend: (text: string) => Promise<void>;
  onFollowUp: (text: string) => Promise<void>;
  onAnswer: (message: ThreadMessage, text: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [phase, setPhase] = useState<Phase>("listening");
  const [caption, setCaption] = useState("");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef<Phase>("listening");
  const spokenMessage = useRef<string | null>(null);
  const narrated = useRef(new Set<string>());
  const closing = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const askPromptRef = useRef(t`Say yes or no, or answer in a sentence.`);
  askPromptRef.current = t`Say yes or no, or answer in a sentence.`;
  const secretPromptRef = useRef(t`Hang up first, then enter the code on screen.`);
  secretPromptRef.current = t`Hang up first, then enter the code on screen.`;

  function setCallPhase(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
  }

  function hangUp() {
    closing.current = true;
    dictation.stop("cancel");
    speaker.stop();
    onClose();
  }

  function interrupt() {
    if (phaseRef.current === "speaking") speaker.stop();
    else dictation.stop("cancel");
    void listen();
  }

  async function listen() {
    if (closing.current) return;
    if (pendingSecretAsk(snapshotRef.current)) {
      dictation.stop("cancel");
      setCallPhase("listening");
      setHeard("");
      return;
    }
    setCallPhase("listening");
    speaker.stop();
    setHeard("");
    try {
      await dictation.listen({
        mode: "endpoint",
        transcribe,
        onFinal: (text) => void handleTranscript(text),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Microphone failed`);
    }
  }

  async function handleTranscript(text: string) {
    if (closing.current || !text.trim()) {
      void listen();
      return;
    }
    dictation.stop("submit");
    const current = snapshotRef.current;
    if (pendingSecretAsk(current)) {
      setHeard("");
      setCaption("");
      setError(t`Hang up, then enter the code on screen.`);
      return;
    }
    setHeard(text);
    setCallPhase("thinking");
    const askId = latestAskId(current);
    const askMessage = current?.messages.find((message) => message.id === askId);
    try {
      if (askMessage) {
        const decision = spokenDecision(text);
        await onAnswer(askMessage, decision ?? text);
      } else if (current?.run && ["running", "queued", "leased"].includes(current.run.status)) {
        await onFollowUp(text);
      } else {
        await onSend(text);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not send that`);
      void listen();
    }
  }

  useEffect(() => {
    closing.current = false;
    spokenMessage.current = null;
    narrated.current.clear();
    const unsubSpeech = speaker.subscribe((state) => {
      if (state.status === "speaking") {
        setCallPhase("speaking");
        setCaption(state.caption ?? "");
      } else if (state.status === "idle" && phaseRef.current !== "listening") {
        setCaption("");
        void listen();
      }
      if (state.error) setError(state.error);
    });
    const unsubDictation = dictation.subscribe((state) => {
      if (state.status === "listening") {
        setHeard(pendingSecretAsk(snapshotRef.current) ? "" : state.transcript);
      }
      if (state.error) setError(state.error);
    });
    void listen();
    return () => {
      closing.current = true;
      unsubSpeech();
      unsubDictation();
      dictation.stop("cancel");
      speaker.stop();
    };
  }, [botId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        hangUp();
      }
      if (event.key === " " && phaseRef.current !== "listening") {
        event.preventDefault();
        interrupt();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (closing.current || phaseRef.current === "listening") return;
    const messages = snapshot?.messages ?? [];
    const lastBot = [...messages].reverse().find((message) => message.role === "bot");
    if (lastBot && lastBot.id !== spokenMessage.current) {
      const text = speechFromBlocks(lastBot.blocks);
      const ask = lastBot.blocks.find(
        (block) => block.kind === "ask" && block.status !== "answered",
      );
      const secretAsk = ask && isSecretAskBlock(ask);
      if (text) {
        spokenMessage.current = lastBot.id;
        dictation.stop("cancel");
        void speaker.speak(
          secretAsk
            ? `${text}. ${secretPromptRef.current}`
            : ask
              ? `${text}. ${askPromptRef.current}`
              : text,
          {
            botId,
            messageId: lastBot.id,
          },
        );
        return;
      }
      const runActive =
        snapshot?.run && ["running", "queued", "leased"].includes(snapshot.run.status);
      if (!runActive) {
        spokenMessage.current = lastBot.id;
        void listen();
        return;
      }
    }
    if (snapshot?.run && ["running", "queued", "leased"].includes(snapshot.run.status)) {
      const phrases: string[] = [];
      let lastKey = "";
      for (const message of messages) {
        for (const block of message.blocks) {
          if (block.kind !== "progress" && block.kind !== "subagent") continue;
          const key = `${message.id}:${block.kind}:${block.kind === "subagent" ? block.status : block.text}`;
          if (narrated.current.has(key)) continue;
          const phrase =
            block.kind === "subagent"
              ? narrateTool("run_subagent")
              : (narrateTool(block.text.split(/\s+/)[0] ?? "") ?? speakableProgress(block.text));
          if (!phrase) continue;
          narrated.current.add(key);
          phrases.push(phrase);
          lastKey = key;
        }
      }
      if (phrases.length) {
        void speaker.speak(phrases.join(". "), { botId, messageId: `narrate:${lastKey}` });
      }
    }
  }, [snapshot, botId]);

  useEffect(() => {
    if (!pendingSecretAsk(snapshot)) return;
    dictation.stop("cancel");
    setHeard("");
  }, [snapshot]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) hangUp();
      }}
    >
      <DialogContent
        data-testid="call-view"
        showCloseButton={false}
        className="max-w-[420px] rounded-3xl p-6 text-center sm:max-w-[420px]"
      >
        <DialogHeader className="items-center gap-2">
          <div className="text-[13px] uppercase tracking-[0.12em] text-muted-foreground/80">
            <Trans>Call</Trans>
          </div>
          <DialogTitle className="text-[22px]">{botName}</DialogTitle>
        </DialogHeader>
        <div className="mt-1 text-[15px] text-foreground/75">
          {phase === "listening" ? (
            <Trans>Listening…</Trans>
          ) : phase === "speaking" ? (
            <Trans>Speaking…</Trans>
          ) : (
            <Trans>Working…</Trans>
          )}
        </div>
        <p className="min-h-[3.2em] text-[14.5px] leading-[1.5] text-muted-foreground">
          {phase === "listening" ? heard || t`Say something. Silence sends it.` : caption}
        </p>
        {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
        <div className="mt-2 flex justify-center gap-3">
          <Button variant="outline" className="rounded-full" onClick={interrupt}>
            <Trans>Interrupt</Trans>
          </Button>
          <Button variant="destructive" className="rounded-full" onClick={hangUp}>
            <Trans>Hang up</Trans>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground/80">
          <Trans>Space interrupts · Esc hangs up</Trans>
        </p>
      </DialogContent>
    </Dialog>
  );
}

function pendingSecretAsk(snapshot: ThreadSnapshot | null) {
  const askId = latestAskId(snapshot);
  const askMessage = snapshot?.messages.find((message) => message.id === askId);
  return askMessage?.blocks.some(
    (block) => block.kind === "ask" && isSecretAskBlock(block) && block.status !== "answered",
  );
}

function latestAskId(snapshot: ThreadSnapshot | null): string | null {
  if (snapshot?.run?.status !== "waiting_input") return null;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message?.runId !== snapshot.run.id) continue;
    if (message.blocks.some((block) => block.kind === "ask" && block.status !== "answered")) {
      return message.id;
    }
  }
  return null;
}

function speakableProgress(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return null;
  return trimmed;
}
