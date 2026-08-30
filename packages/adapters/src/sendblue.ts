import type {
  AdapterContext,
  AdapterDescriptor,
  MessagingCapabilities,
  MessagingDirectRequest,
  MessagingGroup,
  MessagingGroupRequest,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingOutboundStatus,
  MessagingProvider,
  MessagingSendResult,
  MessagingTypingRequest,
} from "@rakazo/adapter-kit";

const DEFAULT_BASE_URL = "https://api.sendblue.com";

export interface SendBlueConfig {
  apiKeyId: string;
  apiSecret: string;
  signingSecret: string;
  phoneNumber: string;
  baseUrl?: string;
}

export interface SendBlueEnvironmentValues {
  sendblueApiKeyId: string | undefined;
  sendblueApiSecret: string | undefined;
  sendblueSigningSecret: string | undefined;
  sendbluePhoneNumber: string | undefined;
}

export function sendBlueConfigFromEnv(values: SendBlueEnvironmentValues): SendBlueConfig {
  return {
    apiKeyId: values.sendblueApiKeyId ?? "",
    apiSecret: values.sendblueApiSecret ?? "",
    signingSecret: values.sendblueSigningSecret ?? "",
    phoneNumber: values.sendbluePhoneNumber ?? "",
  };
}

/** All four values present, and never live under the test runner. */
export function isSendBlueEnabled(config: Partial<SendBlueConfig>): boolean {
  return Boolean(
    config.apiKeyId &&
      config.apiSecret &&
      config.signingSecret &&
      config.phoneNumber &&
      !process.env.VITEST,
  );
}

/**
 * Phone-created users have no per-user model credential, so the surface also
 * requires the deployment model key — without it their runs cannot execute.
 */
export function isPhoneSurfaceEnabled(
  config: Partial<SendBlueConfig>,
  deploymentModelKey: string | undefined,
): boolean {
  return isSendBlueEnabled(config) && Boolean(deploymentModelKey);
}

/** @deprecated Prefer MessagingInboundEvent from adapter-kit. */
export type SendBlueInboundEvent = MessagingInboundEvent;
/** @deprecated Prefer MessagingInboundMessage from adapter-kit. */
export type SendBlueInboundMessage = MessagingInboundMessage;
/** @deprecated Prefer MessagingOutboundStatus from adapter-kit. */
export type SendBlueOutboundStatus = MessagingOutboundStatus;

/** Normalize a SendBlue webhook payload into provider-neutral inbound events. */
export function parseSendBlueInbound(payload: unknown): MessagingInboundEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (typeof body.message_handle !== "string" || !body.message_handle) return null;
  if (body.is_outbound === true) {
    return {
      type: "status",
      handle: body.message_handle,
      status: typeof body.status === "string" ? body.status : "",
    };
  }
  if (body.is_outbound !== true && typeof body.from_number === "string") {
    return {
      type: "message",
      handle: body.message_handle,
      fromNumber: body.from_number,
      groupId: typeof body.group_id === "string" && body.group_id ? body.group_id : null,
      groupName: typeof body.group_display_name === "string" ? body.group_display_name : null,
      participants: Array.isArray(body.participants)
        ? body.participants.filter((p): p is string => typeof p === "string")
        : [],
      content: typeof body.content === "string" ? body.content : "",
      mediaUrl: typeof body.media_url === "string" && body.media_url ? body.media_url : null,
    };
  }
  return null;
}

export class SendBlueMessagingProvider implements MessagingProvider {
  constructor(
    private readonly config: SendBlueConfig,
    private readonly dependencies: { fetch?: typeof globalThis.fetch } = {},
  ) {
    // The API secret rides every request header; never send it cleartext.
    if (config.baseUrl && !config.baseUrl.startsWith("https://")) {
      throw new Error(`SendBlue baseUrl must use HTTPS: ${config.baseUrl}`);
    }
  }

  describe(): AdapterDescriptor<MessagingCapabilities> {
    return {
      id: "sendblue",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { direct: true, groups: true, typing: true },
    };
  }

  async sendDirect(
    request: MessagingDirectRequest,
    context: AdapterContext,
  ): Promise<MessagingSendResult> {
    const data = await this.call(
      "/api/send-message",
      {
        number: request.to,
        from_number: this.config.phoneNumber,
        content: request.body,
      },
      context,
    );
    return { handle: messageHandle(data) };
  }

  async sendTypingIndicator(
    request: MessagingTypingRequest,
    context: AdapterContext,
  ): Promise<void> {
    // Best effort: the vendor answers SENT even when bubbles cannot be
    // delivered (stale chat, non-iMessage recipient), so there is nothing
    // useful to return.
    await this.call(
      "/api/send-typing-indicator",
      { number: request.to, from_number: this.config.phoneNumber },
      context,
    );
  }

  async sendGroup(
    request: MessagingGroupRequest,
    context: AdapterContext,
  ): Promise<MessagingSendResult> {
    const data = await this.call(
      "/api/send-group-message",
      {
        group_id: request.groupId,
        from_number: this.config.phoneNumber,
        content: request.body,
      },
      context,
    );
    return { handle: messageHandle(data) };
  }

  async getGroup(groupId: string, context: AdapterContext): Promise<MessagingGroup> {
    const fetchImpl = this.dependencies.fetch ?? globalThis.fetch;
    const response = await fetchImpl(
      `${this.baseUrl()}/api/v2/groups/${encodeURIComponent(groupId)}`,
      {
        headers: this.headers(),
        signal: context.signal,
        // Never let a redirect forward the sb-api-* headers cross-origin.
        redirect: "error",
      },
    );
    const data = await parseResponse(response, `GET /api/v2/groups/${groupId}`);
    // Live SendBlue wraps the group under `data`; older flat fixtures still work.
    const envelope = asRecord(data);
    const record = asRecord(envelope.data ?? data);
    return {
      id:
        (typeof record.group_id === "string" && record.group_id) ||
        (typeof record.id === "string" && record.id) ||
        groupId,
      name:
        typeof record.group_name === "string"
          ? record.group_name
          : typeof record.group_display_name === "string"
            ? record.group_display_name
            : typeof record.name === "string"
              ? record.name
              : null,
      participants: Array.isArray(record.participant_numbers)
        ? record.participant_numbers.filter((p): p is string => typeof p === "string")
        : Array.isArray(record.participants)
          ? record.participants.filter((p): p is string => typeof p === "string")
          : [],
    };
  }

  private baseUrl(): string {
    return this.config.baseUrl ?? DEFAULT_BASE_URL;
  }

  private headers(): Record<string, string> {
    return {
      "sb-api-key-id": this.config.apiKeyId,
      "sb-api-secret-key": this.config.apiSecret,
      "content-type": "application/json",
    };
  }

  private async call(
    path: string,
    body: Record<string, unknown>,
    context: AdapterContext,
  ): Promise<unknown> {
    const fetchImpl = this.dependencies.fetch ?? globalThis.fetch;
    const response = await fetchImpl(`${this.baseUrl()}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: context.signal,
      // Never let a redirect forward the sb-api-* headers cross-origin.
      redirect: "error",
    });
    return parseResponse(response, `POST ${path}`);
  }
}

function asRecord(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

function messageHandle(data: unknown): string {
  const record = asRecord(data);
  const handle = record.message_handle ?? record.handle;
  if (typeof handle !== "string" || !handle) {
    throw new Error("SendBlue response did not include a message handle");
  }
  return handle;
}

async function parseResponse(response: Response, operation: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`SendBlue ${operation} failed with ${response.status}: ${text.slice(0, 200)}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`SendBlue ${operation} returned invalid JSON`);
  }
}
