import { createHash } from "node:crypto";
import type {
  AdapterContext,
  AgentInputAudio,
  AgentInputImage,
  ArtifactStore,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  isAttachmentAudioMimeType,
  isAttachmentImageMimeType,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import sharp from "sharp";

/** One native prompt, including hydrated history, has a bounded media budget. */
export const AGENT_INPUT_MEDIA_MAX_BYTES = ATTACHMENT_MAX_BYTES;
export const AGENT_INPUT_MEDIA_MAX_COUNT = ATTACHMENT_MAX_COUNT;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_FRAMES = 256;
const SAFE_STORAGE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}$/;

export class AgentInputMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInputMediaError";
  }
}

function invalid(): never {
  throw new AgentInputMediaError("Attached media content does not match its declared format.");
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return Buffer.from(
    bytes.buffer,
    bytes.byteOffset + start,
    Math.min(length, bytes.length - start),
  ).toString("latin1");
}

/** Check the container and required headers without executing codecs or writing a host file. */
export function validateAudioContent(mimeType: string, bytes: Uint8Array): void {
  if (
    !(bytes instanceof Uint8Array) ||
    !isAttachmentAudioMimeType(mimeType) ||
    bytes.length === 0 ||
    bytes.length > ATTACHMENT_MAX_BYTES
  )
    invalid();
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (mimeType) {
    case "audio/wav": {
      if (
        data.length < 44 ||
        ascii(data, 0, 4) !== "RIFF" ||
        ascii(data, 8, 4) !== "WAVE" ||
        data.readUInt32LE(4) + 8 !== data.length
      )
        invalid();
      let format = false;
      let samples = false;
      let offset = 12;
      for (; offset + 8 <= data.length; ) {
        const size = data.readUInt32LE(offset + 4);
        const end = offset + 8 + size;
        if (end > data.length) invalid();
        const tag = ascii(data, offset, 4);
        if (tag === "fmt ") {
          if (
            size < 16 ||
            ![1, 3, 0xfffe].includes(data.readUInt16LE(offset + 8)) ||
            data.readUInt16LE(offset + 10) < 1 ||
            data.readUInt16LE(offset + 10) > 32 ||
            data.readUInt32LE(offset + 12) < 1 ||
            data.readUInt32LE(offset + 12) > 384_000 ||
            data.readUInt16LE(offset + 22) < 1 ||
            data.readUInt16LE(offset + 22) > 64
          )
            invalid();
          format = true;
        }
        if (tag === "data" && size > 0) samples = true;
        offset = end + (size % 2);
      }
      if (!format || !samples || offset !== data.length) invalid();
      return;
    }
    case "audio/mpeg": {
      let offset = 0;
      if (ascii(data, 0, 3) === "ID3") {
        if (
          data.length < 10 ||
          data[3]! < 2 ||
          data[3]! > 4 ||
          [...data.subarray(6, 10)].some((n) => n > 127)
        )
          invalid();
        offset = 10 + ((data[6]! << 21) | (data[7]! << 14) | (data[8]! << 7) | data[9]!);
        if (data[5]! & 0x10) offset += 10;
      }
      // MPEG frame sync, non-reserved version/layer/bitrate/sample-rate.
      if (
        offset + 4 > data.length ||
        data[offset] !== 0xff ||
        (data[offset + 1]! & 0xe0) !== 0xe0 ||
        (data[offset + 1]! & 0x18) === 0x08 ||
        (data[offset + 1]! & 0x06) === 0 ||
        [0, 15].includes(data[offset + 2]! >> 4) ||
        (data[offset + 2]! & 0x0c) === 0x0c
      )
        invalid();
      const version = (data[offset + 1]! >> 3) & 3;
      const layer = (data[offset + 1]! >> 1) & 3;
      const bitrateIndex = data[offset + 2]! >> 4;
      const bitrates =
        version === 3
          ? layer === 3
            ? [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
            : layer === 2
              ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
              : [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
          : layer === 3
            ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
            : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
      const rate =
        [44100, 48000, 32000][(data[offset + 2]! >> 2) & 3]! /
        (version === 3 ? 1 : version === 2 ? 2 : 4);
      const padding = (data[offset + 2]! >> 1) & 1;
      const frameBytes =
        layer === 3
          ? (Math.floor((12 * bitrates[bitrateIndex]! * 1000) / rate) + padding) * 4
          : Math.floor(
              ((layer === 1 && version !== 3 ? 72 : 144) * bitrates[bitrateIndex]! * 1000) / rate,
            ) + padding;
      if (frameBytes < 4 || offset + frameBytes > data.length) invalid();
      return;
    }
    case "audio/mp4": {
      if (data.length < 24 || ascii(data, 4, 4) !== "ftyp") invalid();
      let media = false;
      let audio = false;
      const boxes = (start: number, end: number, depth: number) => {
        if (depth > 3) invalid();
        for (let offset = start; offset < end; ) {
          if (offset + 8 > end) invalid();
          const declared = data.readUInt32BE(offset);
          const size = declared === 0 ? end - offset : declared;
          // Extended-size boxes are unnecessary within the bounded attachment size.
          if (size < 8 || offset + size > end) invalid();
          const tag = ascii(data, offset + 4, 4);
          if (tag === "mdat" && depth === 0 && size > 8) media = true;
          if (["moov", "trak", "mdia"].includes(tag)) boxes(offset + 8, offset + size, depth + 1);
          if (tag === "hdlr" && depth === 3) {
            if (size < 24) invalid();
            const handler = ascii(data, offset + 16, 4);
            if (handler === "vide") invalid();
            if (handler === "soun") audio = true;
          }
          offset += size;
        }
      };
      boxes(0, data.length, 0);
      if (!media || !audio) invalid();
      return;
    }
    case "audio/webm": {
      if (
        data.length < 32 ||
        data.readUInt32BE(0) !== 0x1a45dfa3 ||
        !data.subarray(0, 128).includes(Buffer.from("webm")) ||
        !(data.includes(Buffer.from("A_OPUS")) || data.includes(Buffer.from("A_VORBIS"))) ||
        data.includes(Buffer.from("V_VP")) ||
        data.includes(Buffer.from("V_AV1"))
      )
        invalid();
      return;
    }
    case "audio/ogg": {
      if (data.length < 28 || ascii(data, 0, 4) !== "OggS" || data[4] !== 0 || data[26] === 0)
        invalid();
      const segments = data[26]!;
      if (27 + segments > data.length) invalid();
      const pageBytes = [...data.subarray(27, 27 + segments)].reduce(
        (sum, value) => sum + value,
        0,
      );
      if (27 + segments + pageBytes > data.length) invalid();
      const start = 27 + segments;
      if (ascii(data, start, 8) !== "OpusHead" && ascii(data, start, 7) !== "\x01vorbis") invalid();
      return;
    }
    case "audio/flac": {
      if (
        data.length < 42 ||
        ascii(data, 0, 4) !== "fLaC" ||
        (data[4]! & 0x7f) !== 0 ||
        data.readUIntBE(5, 3) !== 34
      )
        invalid();
      let offset = 4;
      let last = false;
      while (!last) {
        if (offset + 4 > data.length || (data[offset]! & 0x7f) === 127) invalid();
        last = (data[offset]! & 0x80) !== 0;
        offset += 4 + data.readUIntBE(offset + 1, 3);
        if (offset > data.length) invalid();
      }
      if (offset + 4 > data.length || data[offset] !== 0xff || (data[offset + 1]! & 0xfe) !== 0xf8)
        invalid();
      return;
    }
    default:
      invalid();
  }
}

export async function validateAgentInputMedia(media: {
  images?: readonly AgentInputImage[];
  audio?: readonly AgentInputAudio[];
}): Promise<void> {
  const images = media.images ?? [];
  const audio = media.audio ?? [];
  if (!Array.isArray(images) || !Array.isArray(audio)) invalid();
  if (images.length + audio.length > AGENT_INPUT_MEDIA_MAX_COUNT) {
    throw new AgentInputMediaError("Native media exceeds the 4 attachment / 10 MiB prompt limit.");
  }
  let total = 0;
  for (const item of [...images, ...audio]) {
    if (
      !item ||
      !(item.data instanceof Uint8Array) ||
      item.data.byteLength === 0 ||
      typeof item.name !== "string" ||
      !item.name ||
      item.name.length > 255
    )
      invalid();
    total += item.data.byteLength;
    if (total > AGENT_INPUT_MEDIA_MAX_BYTES) {
      throw new AgentInputMediaError(
        "Native media exceeds the 4 attachment / 10 MiB prompt limit.",
      );
    }
  }
  for (const audio of media.audio ?? []) validateAudioContent(audio.mimeType, audio.data);
  for (const image of media.images ?? []) {
    if (!isAttachmentImageMimeType(image.mimeType)) invalid();
    try {
      const decoder = sharp(image.data, {
        limitInputPixels: MAX_IMAGE_PIXELS,
        failOn: "warning",
        animated: true,
      }).timeout({ seconds: 5 });
      const metadata = await decoder.metadata();
      const expected = image.mimeType.slice("image/".length);
      if (
        metadata.format !== expected ||
        (metadata.pages ?? 1) > MAX_IMAGE_FRAMES ||
        !metadata.width ||
        !metadata.height ||
        metadata.width * (metadata.pageHeight ?? metadata.height) * (metadata.pages ?? 1) >
          MAX_IMAGE_PIXELS
      )
        invalid();
      // Decode a bounded thumbnail to reject truncated/corrupt payloads; original bytes are retained.
      await decoder.resize(1, 1).png().toBuffer();
    } catch {
      invalid();
    }
  }
}

/** Only DB-authorized artifact IDs become media; URLs and filesystem paths are never input. */
export async function loadCurrentTurnMedia(
  deps: { prisma: Pick<PrismaClient, "artifact">; artifacts?: ArtifactStore },
  blocks: MessageBlock[] | undefined,
  context: AdapterContext,
): Promise<{ images: AgentInputImage[]; audio: AgentInputAudio[] }> {
  const mediaBlocks =
    blocks?.filter(
      (block): block is Extract<MessageBlock, { kind: "image" | "file" }> =>
        block.kind === "image" || (block.kind === "file" && block.mimeType.startsWith("audio/")),
    ) ?? [];
  const result: { images: AgentInputImage[]; audio: AgentInputAudio[] } = { images: [], audio: [] };
  if (!mediaBlocks.length) return result;
  context.signal.throwIfAborted();
  if (!deps.artifacts) throw new AgentInputMediaError("Attached media storage is unavailable.");
  if (mediaBlocks.length > AGENT_INPUT_MEDIA_MAX_COUNT)
    throw new AgentInputMediaError("Native media exceeds the attachment count limit.");
  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: mediaBlocks.map((block) => block.artifactId) },
      spaceId: context.spaceId,
      userId: context.userId,
    },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      name: true,
      mimeType: true,
      size: true,
      hash: true,
      storageKey: true,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  let remainingBytes = AGENT_INPUT_MEDIA_MAX_BYTES;
  for (const block of mediaBlocks) {
    context.signal.throwIfAborted();
    const row = byId.get(block.artifactId);
    if (!row || row.spaceId !== context.spaceId || row.userId !== context.userId)
      throw new AgentInputMediaError("Attached media is unavailable in this account and space.");
    if (
      row.mimeType !== block.mimeType ||
      (block.kind === "image"
        ? !isAttachmentImageMimeType(row.mimeType)
        : !isAttachmentAudioMimeType(row.mimeType))
    )
      invalid();
    if (!Number.isSafeInteger(row.size) || row.size < 1 || row.size > remainingBytes)
      throw new AgentInputMediaError("Native media exceeds the 10 MiB prompt limit.");
    if (!SAFE_STORAGE_KEY.test(row.storageKey) || row.storageKey === "." || row.storageKey === "..")
      throw new AgentInputMediaError("Attached media storage reference is invalid.");
    if (!/^[a-f0-9]{64}$/.test(row.hash))
      throw new AgentInputMediaError("Attached media integrity metadata is unavailable.");
    const bytes = await deps.artifacts.get(row.storageKey, context, { maxBytes: row.size });
    context.signal.throwIfAborted();
    if (
      bytes.byteLength !== row.size ||
      createHash("sha256").update(bytes).digest("hex") !== row.hash
    )
      throw new AgentInputMediaError("Attached media failed its integrity check.");
    if (isAttachmentAudioMimeType(row.mimeType))
      result.audio.push({ name: row.name, mimeType: row.mimeType, data: bytes });
    else
      result.images.push({
        name: row.name,
        mimeType: row.mimeType as AgentInputImage["mimeType"],
        data: bytes,
      });
    remainingBytes -= bytes.byteLength;
  }
  await validateAgentInputMedia(result);
  context.signal.throwIfAborted();
  return result;
}
