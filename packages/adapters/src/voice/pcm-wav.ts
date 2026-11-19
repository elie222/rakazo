const BYTES_PER_SAMPLE = 2;
const HEADER_BYTES = 44;

export interface PcmFormat {
  sampleRate: number;
  channels: number;
}

/** The sample rate and channel count a provider names in an `audio/pcm;rate=…;channels=…` type. */
export function parsePcmContentType(contentType: string | null): PcmFormat | undefined {
  const [type, ...params] = (contentType ?? "").split(";").map((part) => part.trim());
  if (type?.toLowerCase() !== "audio/pcm") return undefined;
  const value = (name: string) => {
    const param = params.find((entry) => entry.toLowerCase().startsWith(`${name}=`));
    return param ? Number(param.slice(name.length + 1)) : Number.NaN;
  };
  const sampleRate = value("rate");
  // Without a channel count the samples are mono.
  const channels = params.some((entry) => entry.toLowerCase().startsWith("channels="))
    ? value("channels")
    : 1;
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 192_000) return undefined;
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) return undefined;
  return { sampleRate, channels };
}

/** Raw 16-bit signed little-endian samples as a playable WAV file; a trailing partial frame is dropped. */
export function pcmToWav(pcm: Uint8Array, format: PcmFormat): Uint8Array {
  const blockAlign = format.channels * BYTES_PER_SAMPLE;
  const dataBytes = pcm.byteLength - (pcm.byteLength % blockAlign);
  const wav = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  wav.set(pcm.subarray(0, dataBytes), HEADER_BYTES);
  return wav;
}
