import type {
  NativeExecutionControl,
  NativeExecutionProvider,
  NativeExecutionStart,
} from "@rakazo/adapter-kit";
import { ExecutionModelsSchema } from "@rakazo/contracts";
import { executionSnapshotSchema } from "@rakazo/native-runtime/wire";
import { z } from "zod";
import { readBodyCapped } from "./../web/web-ssrf.js";

export const executionServiceDescriptionSchema = z.object({
  id: z.string().uuid(),
  profiles: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        revision: z.number().int().positive(),
        spaceId: z.string().min(1).max(256),
        userIds: z.array(z.string().min(1).max(256)).max(1000),
        computerId: z.string().min(1).max(256),
        label: z.string().min(1).max(100),
        engineVersion: z.string().min(1).max(100),
        defaultModel: z.string().min(1).max(256).optional(),
        models: ExecutionModelsSchema.optional(),
        status: z.enum([
          "missing",
          "unsupported",
          "unauthenticated",
          "unverified",
          "unavailable",
          "stopped",
          "ready",
        ]),
      }),
    )
    .max(1000),
});
export type ExecutionServiceProfile = z.infer<
  typeof executionServiceDescriptionSchema
>["profiles"][number];

export class HttpNativeExecutionProvider implements NativeExecutionProvider {
  private readonly baseUrl: URL;

  constructor(
    private readonly connection: {
      url: string;
      token: string;
      identity?: string;
      scope?: { spaceId: string; userId: string; computerId: string };
      path: string;
      headers?: Record<string, string>;
    },
  ) {
    this.baseUrl = new URL(connection.url);
    if (
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.search ||
      this.baseUrl.hash ||
      this.baseUrl.pathname !== "/"
    )
      throw new Error("Invalid execution service address");
    if (this.baseUrl.protocol !== "https:" && this.baseUrl.protocol !== "http:")
      throw new Error("Invalid execution service protocol");
  }

  private async call(route: string, body?: unknown, signal?: AbortSignal) {
    const url = new URL(`${this.connection.path}${route}`, this.baseUrl).href;
    const headers = {
      ...this.connection.headers,
      authorization: `Bearer ${this.connection.token}`,
      "content-type": "application/json",
      "x-execution-service-id": this.connection.identity ?? "",
      ...(this.connection.scope
        ? {
            "x-execution-scope": Buffer.from(JSON.stringify(this.connection.scope)).toString(
              "base64url",
            ),
          }
        : {}),
    };
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
    // The computer provider supplies this trusted Supervisor endpoint.
    const result = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: deadline,
    });
    if (!result.ok) {
      await result.body?.cancel();
      throw new Error("execution_service_rejected");
    }
    return JSON.parse(
      Buffer.from(await readBodyCapped(result, 5 * 1024 * 1024, deadline)).toString("utf8"),
    );
  }

  async describe(signal?: AbortSignal) {
    const description = executionServiceDescriptionSchema.parse(
      await this.call("/describe", undefined, signal),
    );
    if (this.connection.identity && description.id !== this.connection.identity)
      throw new Error("execution_identity_changed");
    this.connection.identity ??= description.id;
    return description;
  }
  async toolResult(
    request: NativeExecutionControl & { requestId: string; result: string },
    signal?: AbortSignal,
  ) {
    return z.enum(["delivered", "expired"]).parse(await this.call("/tool-result", request, signal));
  }
  async stop(
    request: { runId: string; scope: NativeExecutionStart["scope"]; fence: number },
    signal?: AbortSignal,
  ) {
    z.object({ stopped: z.literal(true) }).parse(await this.call("/stop", request, signal));
  }
  async start(request: NativeExecutionStart, signal?: AbortSignal) {
    return executionSnapshotSchema.parse(await this.call("/start", request, signal));
  }
  async attach(
    request: NativeExecutionControl & { after: number; leaseExpiresAt: string },
    signal?: AbortSignal,
  ) {
    return executionSnapshotSchema.parse(await this.call("/attach", request, signal));
  }
  async respond(
    request: NativeExecutionControl & { requestId: string; answer: string },
    signal?: AbortSignal,
  ) {
    return z.enum(["delivered", "expired"]).parse(await this.call("/respond", request, signal));
  }
  async cancel(request: NativeExecutionControl, signal?: AbortSignal) {
    z.object({ stopped: z.literal(true) }).parse(await this.call("/cancel", request, signal));
  }
  async steer(
    request: NativeExecutionControl & { id: string; text: string },
    signal?: AbortSignal,
  ) {
    return z.enum(["accepted", "unsupported"]).parse(await this.call("/steer", request, signal));
  }
}
