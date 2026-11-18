export const MEETING_SAMPLE_RATE = 16_000;
export const MAX_MEETING_AUDIO_BYTES = MEETING_SAMPLE_RATE * 2 * 14;

/** Convert mono little-endian PCM16 frames to the WAV container voice adapters accept. */
export function meetingAudioWav(samples: Uint8Array) {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(header.length - 8 + samples.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(MEETING_SAMPLE_RATE, 24);
  header.writeUInt32LE(MEETING_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}
