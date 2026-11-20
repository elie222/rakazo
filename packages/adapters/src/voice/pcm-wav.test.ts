import { describe, expect, it } from "vitest";
import { parsePcmContentType, pcmToWav } from "./pcm-wav.js";

describe("parsePcmContentType", () => {
  it("reads the rate and channels", () => {
    expect(parsePcmContentType("audio/pcm;rate=24000;channels=1")).toEqual({
      sampleRate: 24000,
      channels: 1,
    });
    expect(parsePcmContentType("Audio/PCM; channels=2; rate=44100")).toEqual({
      sampleRate: 44100,
      channels: 2,
    });
  });

  it("reads a missing channel count as mono", () => {
    expect(parsePcmContentType("audio/pcm;rate=24000")).toEqual({ sampleRate: 24000, channels: 1 });
  });

  it.each([
    null,
    "audio/mpeg",
    "audio/pcm",
    "audio/pcm;rate=abc;channels=1",
    "audio/pcm;rate=0;channels=1",
    "audio/pcm;rate=24000;channels=99",
  ])("refuses %s", (contentType) => {
    expect(parsePcmContentType(contentType)).toBeUndefined();
  });
});

describe("pcmToWav", () => {
  it("writes a 44-byte header in front of the samples", () => {
    const wav = pcmToWav(new Uint8Array([1, 0, 2, 0, 3, 0]), { sampleRate: 24000, channels: 1 });
    const view = new DataView(wav.buffer);
    const text = (start: number) => String.fromCharCode(...wav.subarray(start, start + 4));
    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    expect(text(12)).toBe("fmt ");
    expect(text(36)).toBe("data");
    expect(view.getUint32(4, true)).toBe(36 + 6);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(28, true)).toBe(48000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect([...wav.subarray(44)]).toEqual([1, 0, 2, 0, 3, 0]);
  });

  it("drops a trailing partial frame", () => {
    const wav = pcmToWav(new Uint8Array([1, 0, 2, 0, 3]), { sampleRate: 16000, channels: 1 });
    expect(wav.byteLength).toBe(44 + 4);
    const stereo = pcmToWav(new Uint8Array([1, 0, 2, 0, 3, 0]), { sampleRate: 16000, channels: 2 });
    expect(stereo.byteLength).toBe(44 + 4);
    expect(new DataView(stereo.buffer).getUint16(32, true)).toBe(4);
  });
});
