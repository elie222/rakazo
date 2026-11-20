import { z } from "zod";
import type { UserAccessCredential } from "./configured-apps.js";
import type {
  CreativeCapabilities,
  CreativeInput,
  CreativeJob,
  CreativeReference,
} from "./creative-contracts.js";
import {
  creativeCapabilitiesSchema,
  creativeJobSchema,
  creativeReferenceSchema,
} from "./creative-contracts.js";
import { readBoundedText } from "./integrations/connector-http.js";

export interface CreativeProvider {
  capabilities(identity: UserAccessCredential, signal: AbortSignal): Promise<CreativeCapabilities>;
  uploadReference(
    identity: UserAccessCredential,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<CreativeReference>;
  submit(
    identity: UserAccessCredential,
    operationId: string,
    input: CreativeInput,
    signal: AbortSignal,
  ): Promise<CreativeJob>;
  job(
    identity: UserAccessCredential,
    operationId: string,
    signal: AbortSignal,
  ): Promise<CreativeJob>;
  output(
    identity: UserAccessCredential,
    operationId: string,
    outputId: string,
    signal: AbortSignal,
  ): Promise<Response>;
}

const httpsLink = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
});
export const creativeConnectionSchema = z.strictObject({
  origin: httpsLink.refine((value) => {
    const url = new URL(value);
    return url.pathname === "/" && !url.search;
  }),
  name: z.string().min(1).max(100),
  icon: httpsLink.optional(),
  authorizationUrl: httpsLink,
  spaceIds: z.array(z.string().min(1)).min(1).optional(),
});
export type CreativeConnectionConfig = z.infer<typeof creativeConnectionSchema>;
const codes = z.enum([
  "authentication_required",
  "authentication_unavailable",
  "account_changed",
  "service_unavailable",
  "authorization_required",
  "forbidden",
  "not_found",
  "operation_conflict",
  "invalid_parameters",
  "rate_limited",
  "selection_unavailable",
  "reference_image_too_large",
  "invalid_reference_image",
  "unsupported_media",
  "reference_media_too_large",
  "invalid_reference_media",
]);
export class CreativeServiceError extends Error {
  constructor(
    readonly code:
      | z.infer<typeof codes>
      | "unavailable"
      | "invalid_response"
      | "capabilities_too_large",
    readonly status = 503,
  ) {
    super(`Creative app: ${code}`);
  }
}

/** Only the current user Access Token goes to the configured origin; no service credentials. */
export class UserCreativeProvider implements CreativeProvider {
  readonly config: CreativeConnectionConfig;
  constructor(
    config: CreativeConnectionConfig,
    private readonly fetcher = globalThis.fetch,
  ) {
    this.config = creativeConnectionSchema.parse(config);
  }
  private async request(
    credential: UserAccessCredential,
    path: string,
    signal: AbortSignal,
    input?: CreativeInput,
    referenceBytes?: Uint8Array,
  ) {
    const send = async (token: string) => {
      if (!token || /\s/.test(token))
        throw new CreativeServiceError("authentication_required", 401);
      try {
        return await this.fetcher(new URL(`/api/integrations/v1${path}`, this.config.origin), {
          method: referenceBytes ? "POST" : input ? "PUT" : "GET",
          redirect: "manual",
          headers: {
            authorization: `Bearer ${token}`,
            ...(input ? { "content-type": "application/json" } : {}),
            ...(referenceBytes ? { "content-type": "application/octet-stream" } : {}),
          },
          ...(input ? { body: JSON.stringify(input) } : {}),
          ...(referenceBytes ? { body: Buffer.from(referenceBytes) } : {}),
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
      } catch (error) {
        if (error instanceof CreativeServiceError) throw error;
        throw new CreativeServiceError("unavailable");
      }
    };
    let response = await send(await credential.accessToken());
    if (response.status === 401 && credential.refreshAccessToken) {
      await response.body?.cancel();
      const token = await credential.refreshAccessToken().catch((error: unknown) => {
        if (error instanceof CreativeServiceError) throw error;
        throw new CreativeServiceError("authentication_unavailable", 503);
      });
      response = await send(token);
    }
    if (!response.ok || response.type === "opaqueredirect") {
      const body = await readBoundedText(response, 4_096).catch(() => ({
        text: "",
        truncated: true,
      }));
      let code: z.infer<typeof codes> | "unavailable" =
        response.status === 401 ? "authentication_required" : "unavailable";
      if (!body.truncated) {
        try {
          const parsed = codes.safeParse(JSON.parse(body.text)?.error?.code);
          if (parsed.success) code = parsed.data;
        } catch {
          /* Never expose upstream text. */
        }
      }
      throw new CreativeServiceError(code, response.status);
    }
    return response;
  }
  private async json(response: Response): Promise<unknown> {
    const body = await readBoundedText(response, 1_000_000);
    try {
      if (!body.truncated) return JSON.parse(body.text);
    } catch {
      /* Sanitized below. */
    }
    throw new CreativeServiceError("invalid_response");
  }
  async capabilities(identity: UserAccessCredential, signal: AbortSignal) {
    const parsed = creativeCapabilitiesSchema.safeParse(
      await this.json(await this.request(identity, "/capabilities", signal)),
    );
    if (!parsed.success) throw new CreativeServiceError("invalid_response");
    return parsed.data;
  }
  async uploadReference(identity: UserAccessCredential, bytes: Uint8Array, signal: AbortSignal) {
    if (!bytes.byteLength) throw new CreativeServiceError("invalid_reference_media", 422);
    const response = await this.request(identity, "/references", signal, undefined, bytes);
    const parsed = creativeReferenceSchema.safeParse(await this.json(response));
    if (response.status !== 201 || !parsed.success || parsed.data.bytes !== bytes.byteLength)
      throw new CreativeServiceError("invalid_response");
    return parsed.data;
  }
  private async readJob(response: Response, operationId: string): Promise<CreativeJob> {
    const parsed = creativeJobSchema.safeParse(await this.json(response));
    if (!parsed.success || parsed.data.operationId !== operationId)
      throw new CreativeServiceError("invalid_response");
    return parsed.data;
  }
  async submit(
    identity: UserAccessCredential,
    operationId: string,
    input: CreativeInput,
    signal: AbortSignal,
  ) {
    z.uuid().parse(operationId);
    const response = await this.request(identity, `/jobs/${operationId}`, signal, input);
    if (response.status !== 200 && response.status !== 202) {
      await response.body?.cancel();
      throw new CreativeServiceError("invalid_response");
    }
    return this.readJob(response, operationId);
  }
  async job(identity: UserAccessCredential, operationId: string, signal: AbortSignal) {
    z.uuid().parse(operationId);
    return this.readJob(await this.request(identity, `/jobs/${operationId}`, signal), operationId);
  }
  async output(
    identity: UserAccessCredential,
    operationId: string,
    outputId: string,
    signal: AbortSignal,
  ) {
    z.uuid().parse(operationId);
    return this.request(
      identity,
      `/jobs/${operationId}/outputs/${encodeURIComponent(outputId)}`,
      signal,
    );
  }
}
