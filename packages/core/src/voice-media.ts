import type { VoiceConversationEvent } from "@rakazo/contracts";

export type VoiceMediaStream = { getTracks(): Array<{ enabled: boolean; stop(): void }> };
export type VoiceMediaPeer = {
  offer(): Promise<string>;
  answer(sdp: string): Promise<void>;
  close(): void;
};

/** Owns microphone lifetime even when permission or connection completes after hang-up. */
export function createVoiceMedia<S extends VoiceMediaStream>(deps: {
  microphone(): Promise<S>;
  peer(stream: S, fail: (error: Error) => void): VoiceMediaPeer;
  connect(offer: string, signal: AbortSignal): AsyncIterable<VoiceConversationEvent>;
  event(event: VoiceConversationEvent): void;
  error(error: unknown): void;
}) {
  const controller = new AbortController();
  let stream: S | undefined;
  let peer: VoiceMediaPeer | undefined;
  let muted = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
    peer?.close();
  };
  const fail = (error: unknown) => {
    if (controller.signal.aborted) return;
    close();
    deps.error(error);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => fail(new Error("The voice connection timed out. Please reconnect.")),
      30000,
    );
  };
  return {
    close,
    mute(value: boolean) {
      muted = value;
      stream?.getTracks().forEach((track) => {
        track.enabled = !value;
      });
    },
    async start() {
      if (started || controller.signal.aborted) return;
      started = true;
      arm();
      try {
        const acquired = await deps.microphone();
        if (controller.signal.aborted) {
          acquired.getTracks().forEach((track) => {
            track.stop();
          });
          return;
        }
        stream = acquired;
        stream.getTracks().forEach((track) => {
          track.enabled = !muted;
        });
        peer = deps.peer(stream, fail);
        const offer = await peer.offer();
        if (controller.signal.aborted) return;
        for await (const event of deps.connect(offer, controller.signal)) {
          if (controller.signal.aborted) break;
          arm();
          if (event.type === "connected") await peer.answer(event.answerSdp);
          if (controller.signal.aborted) break;
          if (event.type === "error") throw new Error(event.message);
          deps.event(event);
          if (event.type === "closed") {
            close();
            break;
          }
        }
        if (!controller.signal.aborted)
          throw new Error("The voice connection ended. Please reconnect.");
      } catch (error) {
        fail(error);
      } finally {
        close();
      }
    },
  };
}
