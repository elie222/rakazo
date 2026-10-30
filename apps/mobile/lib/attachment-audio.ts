import type { AudioPlayer } from "expo-audio";
import { createAudioPlayer } from "expo-audio";

export const INITIAL_ATTACHMENT_AUDIO_STATE = {
  loading: false,
  playing: false,
  currentTime: 0,
  duration: 0,
  error: false,
};
export type AttachmentAudioState = typeof INITIAL_ATTACHMENT_AUDIO_STATE;

/** Owns one native player; download and native module loading happen only on explicit play. */
export function createAttachmentAudioPlayer(
  loadUri: () => Promise<string>,
  onState: (state: AttachmentAudioState) => void,
) {
  let state = { ...INITIAL_ATTACHMENT_AUDIO_STATE };
  let player: AudioPlayer | undefined;
  let subscription: { remove: () => void } | undefined;
  let disposed = false;
  let busy = false;
  let ended = false;
  function update(next: Partial<AttachmentAudioState>) {
    if (disposed) return;
    state = { ...state, ...next };
    onState(state);
  }
  function release() {
    subscription?.remove();
    subscription = undefined;
    player?.release();
    player = undefined;
  }
  return {
    async toggle(): Promise<void> {
      if (disposed || busy) return;
      busy = true;
      update({ loading: true, error: false });
      try {
        if (player?.playing) {
          player.pause();
          update({ playing: false });
          return;
        }
        if (!player) {
          const uri = await loadUri();
          if (disposed) return;
          player = createAudioPlayer({ uri });
          ended = false;
          subscription = player.addListener("playbackStatusUpdate", (status) => {
            if (status.error || status.playbackState === "failed") {
              release();
              update({ error: true, playing: false });
              return;
            }
            ended = status.didJustFinish || ended;
            update({
              playing: status.playing && !status.didJustFinish,
              currentTime: status.currentTime,
              duration: status.duration,
            });
          });
        }
        if (ended) {
          await player.seekTo(0);
          ended = false;
        }
        if (disposed) return;
        player.play();
        update({ playing: true });
      } catch {
        release();
        update({ error: true, playing: false });
      } finally {
        busy = false;
        update({ loading: false });
      }
    },
    dispose() {
      disposed = true;
      release();
    },
  };
}
