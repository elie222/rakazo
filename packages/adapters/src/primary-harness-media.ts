import type {
  AdapterContext,
  AgentInputAudio,
  AgentInputImage,
  AgentRunRequest,
  AgentToolResultContent,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  EXECUTION_HARNESS_VERSIONS,
  isAttachmentAudioMimeType,
  supportedExecutionInputModalities,
} from "@rakazo/contracts";
import { decodeAttachmentBase64 } from "@rakazo/core";
import {
  AGENT_INPUT_MEDIA_MAX_BYTES,
  AGENT_INPUT_MEDIA_MAX_COUNT,
  loadCurrentTurnMedia,
  validateAgentInputMedia,
} from "./agent-input-media.js";

export type NativeMediaHarness = "claude" | "codex" | "kimi";
export interface NativeMediaPart {
  kind: "image" | "audio";
  /** Attribution is data, never an instruction or a native filesystem path. */
  label: string;
  mimeType: string;
  data: string;
}

const protocols = {
  claude: "anthropic",
  codex: "openai-responses",
  kimi: "openai-chat-completions",
} as const;

function assertCapability(
  request: AgentRunRequest,
  harness: NativeMediaHarness,
  kind: "image" | "audio",
) {
  const supported = supportedExecutionInputModalities({
    harness,
    protocol: protocols[harness],
    runtimeVersion: EXECUTION_HARNESS_VERSIONS[harness],
    endpoint: request.model.baseUrl ?? null,
  });
  if (!supported.includes(kind))
    throw new Error(
      `Native ${kind} input is unsupported by this harness and endpoint; transcription is not substituted.`,
    );
  const declared = kind === "image" ? request.model.acceptsImages : request.model.acceptsAudio;
  if (declared !== true)
    throw new Error(`Native ${kind} input is not enabled for this profile's model.`);
}

/** Keep original validated bytes and attribution; never fetch a URL or use an attachment name as a path. */
export async function prepareNativeMedia(
  request: AgentRunRequest,
  harness: NativeMediaHarness,
): Promise<NativeMediaPart[]> {
  const images: AgentInputImage[] = [];
  const audio: AgentInputAudio[] = [];
  const parts: Array<{
    kind: "image" | "audio";
    item: AgentInputImage | AgentInputAudio;
    attribution: Record<string, unknown>;
  }> = [];
  const add = (
    kind: "image" | "audio",
    item: AgentInputImage | AgentInputAudio,
    attribution: Record<string, unknown>,
  ) => {
    assertCapability(request, harness, kind);
    if (kind === "image") images.push(item as AgentInputImage);
    else audio.push(item as AgentInputAudio);
    parts.push({ kind, item, attribution });
  };
  for (const [index, message] of request.history.entries()) {
    const attribution = {
      source: "history",
      historyIndex: index,
      messageId: message.id,
      role: message.role,
    };
    for (const item of message.images ?? []) add("image", item, attribution);
    for (const item of message.audio ?? []) add("audio", item, attribution);
  }
  const current = { source: "current", messageId: request.sourceMessageId, role: "user" };
  for (const item of request.currentTurnImages ?? []) add("image", item, current);
  for (const item of request.currentTurnAudio ?? []) add("audio", item, current);
  await validateAgentInputMedia({ images, audio });
  return parts.map(({ kind, item, attribution }) => ({
    kind,
    mimeType: item.mimeType,
    data: Buffer.from(item.data).toString("base64"),
    label: JSON.stringify({ ...attribution, name: item.name }),
  }));
}

/** Tool images enter the same decoded-byte validation boundary as uploaded images. */
export async function validateNativeToolContent(
  content: AgentToolResultContent[],
  request: AgentRunRequest,
  harness: NativeMediaHarness,
): Promise<void> {
  const images: AgentInputImage[] = [];
  if (!Array.isArray(content) || content.length > 64)
    throw new Error("Native tool content exceeds its limit.");
  let encodedBytes = 0;
  for (const item of content) {
    if (!item || typeof item !== "object") throw new Error("Invalid native tool content.");
    if (item.type === "text") {
      if (typeof item.text !== "string") throw new Error("Invalid native tool text.");
      continue;
    }
    if (item.type !== "image") throw new Error("Unsupported native tool media type.");
    assertCapability(request, harness, "image");
    if (
      typeof item.data !== "string" ||
      item.data.length > 14 * 1024 * 1024 ||
      item.data.trim() !== item.data
    )
      throw new Error("Invalid native tool image encoding.");
    encodedBytes += item.data.length;
    if (images.length >= 4 || encodedBytes > 14 * 1024 * 1024)
      throw new Error("Native tool images exceed their combined size limit.");
    const data = decodeAttachmentBase64(item.data);
    images.push({ name: "Tool image", mimeType: item.mimeType, data });
  }
  await validateAgentInputMedia({ images });
}

/** Hydrate only recent authorized history media, preserving speaker attribution and a shared prompt budget. */
export async function withNativeHistoryMedia(
  deps: Parameters<typeof loadCurrentTurnMedia>[0],
  history: AgentRunRequest["history"],
  messages: Array<{ id: string; blocks: MessageBlock[] }>,
  context: AdapterContext,
  options: {
    skipMessageId?: string;
    images?: AgentInputImage[];
    audio?: AgentInputAudio[];
    acceptsImages: boolean;
    acceptsAudio: boolean;
  },
): Promise<AgentRunRequest["history"]> {
  let remainingCount =
    AGENT_INPUT_MEDIA_MAX_COUNT - (options.images?.length ?? 0) - (options.audio?.length ?? 0);
  let remainingBytes =
    AGENT_INPUT_MEDIA_MAX_BYTES -
    [...(options.images ?? []), ...(options.audio ?? [])].reduce(
      (sum, item) => sum + item.data.byteLength,
      0,
    );
  const byId = new Map(messages.map((message) => [message.id, message]));
  const result = history.map((message) => ({ ...message }));
  let turns = 0;
  for (let index = result.length - 1; index >= 0; index--) {
    const message = result[index]!;
    if (!message.id || message.id === options.skipMessageId) continue;
    const stored = byId.get(message.id);
    if (!stored) continue;
    const blocks = stored.blocks.filter(
      (block) =>
        (options.acceptsImages && block.kind === "image") ||
        (options.acceptsAudio &&
          block.kind === "file" &&
          isAttachmentAudioMimeType(block.mimeType)),
    );
    if (!blocks.length) continue;
    if (++turns > 3 || remainingCount <= 0 || remainingBytes <= 0) {
      message.content +=
        "\n[Prior attached media omitted because it exceeds the current prompt budget.]";
      continue;
    }
    try {
      const loaded = await loadCurrentTurnMedia(deps, blocks, context);
      const count = loaded.images.length + loaded.audio.length;
      const bytes = [...loaded.images, ...loaded.audio].reduce(
        (sum, item) => sum + item.data.byteLength,
        0,
      );
      if (count > remainingCount || bytes > remainingBytes) {
        message.content +=
          "\n[Prior attached media omitted because it exceeds the current prompt budget.]";
        continue;
      }
      remainingCount -= count;
      remainingBytes -= bytes;
      if (loaded.images.length) message.images = loaded.images;
      if (loaded.audio.length) message.audio = loaded.audio;
    } catch (error) {
      if (context.signal.aborted) throw error;
      message.content +=
        "\n[Prior attached media is unavailable or could not be validated in this run's authorized scope.]";
    }
  }
  return result;
}
