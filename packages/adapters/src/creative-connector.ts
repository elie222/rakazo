import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { appConnectCard } from "@rakazo/core";
import { recordSecurityEvent } from "@rakazo/db";
import { z } from "zod";
import type { UserAccessCredential } from "./configured-apps.js";
import { scopeConnectorTools } from "./integrations/connector-accounts.js";
import type { CreativeCapabilities } from "./creative-contracts.js";
import { creativeKindSchema, creativeToolInputSchema } from "./creative-contracts.js";
import { CREATIVE_APP_INSTRUCTIONS } from "./creative-instructions.js";
import type { CreativeJobsDeps } from "./creative-jobs.js";
import { CreativeJobs } from "./creative-jobs.js";
import type { CreativeConnectionConfig, CreativeProvider } from "./creative-provider.js";
import { CreativeServiceError } from "./creative-provider.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./runtime/pi/pi-runtime-limits.js";

export type UserAccessCredentialReader = (userId: string) => Promise<UserAccessCredential | null>;
const ID = "creative";
const capabilitiesQuerySchema = z
  .strictObject({
    kind: creativeKindSchema.optional(),
    model: z.string().min(1).max(200).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .refine((query) => !query.model || query.offset === undefined);
const TOOLS: Array<ConnectorTool & { title: string }> = [
  {
    name: "creative_capabilities",
    title: "View models",
    description:
      "Discover models progressively. Use kind (image, video, music) to list IDs, names and types, with complete availability counts and default model IDs. Continue with offset=nextOffset when non-null. Use model (exact model ID) to read that model's full parameter schema, constraints, presets and submission limits before creating media. Display names; use opaque IDs only in calls. Select parameters only when submission.presetOnly is false.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: creativeKindSchema.options },
        model: { type: "string", minLength: 1, maxLength: 200 },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Continue a model list from nextOffset; omit when querying a model.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "creative_submit",
    title: "Create media",
    description: `Create or edit an image, generate video with optional references, or create music using this person's connected app and paid account.

${CREATIVE_APP_INSTRUCTIONS}`,
    readOnly: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "model", "prompt"],
      properties: {
        kind: { type: "string", enum: ["image", "video", "music"] },
        model: {
          type: "string",
          maxLength: 200,
          description: "Use the exact model.id from creative_capabilities, never its display name.",
        },
        prompt: { type: "string", minLength: 1, maxLength: 4_000 },
        preset: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Optional presets[].id from the selected model. Omit to use its defaultPreset; never send an empty string or a display name.",
        },
        parameters: {
          type: "object",
          description:
            "Optional explicit choices from the model parameter schema; preserve false, zero and automatic duration -1. Omitted fields retain the selected preset's defaults. No media, credentials, URLs or headers.",
          additionalProperties: true,
        },
        referenceArtifactIds: {
          type: "array",
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 200 },
          description:
            "Ordered IDs of image, video or audio attachments explicitly selected by this user in this chat. Use artifact IDs from attachment metadata or attachments/<id>.<extension>. Image models accept images only; video models use their published input flags and constraints; music accepts no references. Never supply URLs, paths, data URIs, base64 or external reference IDs, and never substitute descriptions for the actual files.",
        },
      },
    },
  },
  {
    name: "creative_result",
    title: "Check progress",
    description:
      "Read a submitted creation's local status. This never starts a new paid task. Files are delivered to the original chat automatically.",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["operationId"],
      properties: { operationId: { type: "string", format: "uuid" } },
      additionalProperties: false,
    },
  },
];

/** One optional app, using the same catalog, connection actions and approvals on all clients. */
export class CreativeAppConnector implements ManagedConnectorProvider {
  readonly creativeJobs: CreativeJobs;
  constructor(
    private readonly config: CreativeConnectionConfig,
    private readonly provider: CreativeProvider,
    private readonly deps: CreativeJobsDeps,
    private readonly identityReader: UserAccessCredentialReader,
    private readonly connectionScope: (context: AdapterContext) => string,
  ) {
    this.creativeJobs = new CreativeJobs(deps, {
      provider,
      authorize: (context, id, ref) => this.authorize(context, id, ref),
      authorizationBlock: () =>
        appConnectCard({
          connectorId: ID,
          slug: ID,
          name: config.name,
          logo: config.icon ?? null,
          connected: false,
          noAuth: false,
        }),
    });
  }
  describe() {
    return {
      id: ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }
  private async identity(context: AdapterContext) {
    if (this.config.spaceIds && !this.config.spaceIds.includes(context.spaceId))
      throw new CreativeServiceError("forbidden", 403);
    const [identity, member, user] = await Promise.all([
      this.identityReader(context.userId),
      this.deps.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: context.spaceId, userId: context.userId } },
      }),
      this.deps.prisma.user.findUnique({ where: { id: context.userId }, select: { id: true } }),
    ]);
    if (!identity || !member || !user) throw new CreativeServiceError("forbidden", 403);
    return identity;
  }
  private prefix(context: AdapterContext, identity: UserAccessCredential) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.config.origin,
          context.spaceId,
          context.userId,
          identity.accountId,
          identity.binding,
        ]),
      )
      .digest("hex");
  }
  private async rows(context: AdapterContext, statuses = ["connected"]) {
    return this.deps.prisma.connection.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        connectorId: ID,
        provider: ID,
        status: { in: statuses },
      },
    });
  }
  private async authorizedRows(context: AdapterContext) {
    const identity = await this.identity(context);
    const prefix = this.prefix(context, identity);
    return (await this.rows(context)).filter((row) => row.providerRef === prefix);
  }
  /** Provision only the authenticated person's connection; retain explicit disconnects. */
  async ensureConnection(context: AdapterContext) {
    const identity = await this.identity(context);
    const prefix = this.prefix(context, identity);
    const row = await this.deps.prisma.$transaction(async (tx) => {
      const scope = this.connectionScope(context);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('connection-provider'), hashtext(${scope}))`;
      const rows = await tx.connection.findMany({
        where: {
          spaceId: context.spaceId,
          userId: context.userId,
          connectorId: ID,
          provider: ID,
        },
      });
      const existing = rows.find(
        (row) => ["pending", "connected"].includes(row.status) && row.providerRef === prefix,
      );
      // Existing revoked/error/stale bindings need an intentional reconnect. Never revive them.
      if (existing || rows.length) return existing;
      const id = randomUUID();
      return tx.connection.create({
        data: {
          id,
          spaceId: context.spaceId,
          userId: context.userId,
          connectorId: ID,
          provider: ID,
          displayName: this.config.name,
          status: "pending",
          providerRef: prefix,
        },
      });
    });
    if (!row?.providerRef || row.status !== "pending") return;
    try {
      await this.provider.capabilities(identity, context.signal);
    } catch (error) {
      if (
        error instanceof CreativeServiceError &&
        [
          "authorization_required",
          "authentication_unavailable",
          "unavailable",
          "rate_limited",
        ].includes(error.code)
      )
        return;
      throw error;
    }
    const updated = await this.deps.prisma.connection.updateMany({
      where: { id: row.id, status: "pending", providerRef: row.providerRef },
      data: { status: "connected" },
    });
    if (updated.count)
      await recordSecurityEvent({
        type: "credential.created",
        userId: context.userId,
        spaceId: context.spaceId,
        metadata: { procedure: context.operationId, kind: "connection", connectionId: row.id },
      });
  }
  private async authorize(context: AdapterContext, id: string, ref: string) {
    const identity = await this.identity(context);
    const row = await this.deps.prisma.connection.findFirst({
      where: {
        id,
        spaceId: context.spaceId,
        userId: context.userId,
        connectorId: ID,
        provider: ID,
        status: "connected",
        providerRef: ref,
      },
    });
    if (!row || ref !== this.prefix(context, identity))
      throw new CreativeServiceError("forbidden", 403);
    return identity;
  }
  async catalog(context: AdapterContext, query = "") {
    if (
      (this.config.spaceIds && !this.config.spaceIds.includes(context.spaceId)) ||
      (query &&
        !this.config.name.toLowerCase().includes(query.toLowerCase()) &&
        !ID.includes(query.toLowerCase()))
    )
      return [];
    const connected = await this.listConnectedExternalIds(context).catch(() => []);
    return [
      {
        connectorId: ID,
        slug: ID,
        name: this.config.name,
        logo: this.config.icon ?? null,
        connected: connected.length > 0,
        noAuth: false,
      },
    ];
  }
  async listConnectedExternalIds(context: AdapterContext) {
    await this.ensureConnection(context);
    const identity = await this.identity(context);
    const prefix = this.prefix(context, identity);
    const rows = (await this.rows(context, ["pending", "connected"])).filter(
      (row) => row.providerRef === prefix,
    );
    return rows.some((row) => row.status === "connected") ? [ID] : [];
  }
  async listReconnectRefs(context: AdapterContext) {
    const rows = await this.rows(context, ["pending", "connected"]);
    try {
      const identity = await this.identity(context);
      const prefix = this.prefix(context, identity);
      return rows
        .filter((row) => row.providerRef !== prefix)
        .flatMap((row) => (row.providerRef ? [row.providerRef] : []));
    } catch (error) {
      if (error instanceof CreativeServiceError && error.code === "forbidden")
        return rows.flatMap((row) => (row.providerRef ? [row.providerRef] : []));
      throw error;
    }
  }
  async begin(request: { provider: string; redirectUrl: string }, context: AdapterContext) {
    if (request.provider !== ID) throw new CreativeServiceError("not_found", 404);
    const identity = await this.identity(context);
    return {
      state: this.prefix(context, identity),
      authorizationUrl: this.config.authorizationUrl,
    };
  }
  async connectionReady(context: AdapterContext, externalId: string) {
    if (externalId !== ID) return false;
    const identity = await this.identity(context);
    const prefix = this.prefix(context, identity);
    const eligible = (await this.rows(context, ["pending", "connected"])).find(
      (row) => row.providerRef === prefix,
    );
    if (!eligible?.providerRef) return false;
    try {
      await this.provider.capabilities(identity, context.signal);
      return true;
    } catch (error) {
      if (error instanceof CreativeServiceError && error.code === "authorization_required")
        return false;
      throw error;
    }
  }
  async complete(request: { state: string; code?: string }, context: AdapterContext) {
    const identity = await this.identity(context);
    if (request.state !== this.prefix(context, identity))
      throw new CreativeServiceError("forbidden", 403);
    if (!(await this.connectionReady(context, ID)))
      throw new CreativeServiceError("authorization_required", 403);
    return { connectionRef: request.state };
  }
  // v1 has no remote revoke endpoint. The shared action revokes the local row first.
  async revoke(_connectionRef: string, _context: AdapterContext) {}
  async discoverTools(context: AdapterContext) {
    const allowed = await this.authorizedRows(context).catch(() => []);
    const selected = context.connectedConnections;
    // The existing settings-only discovery returns display names. Runs always retain
    // the account-scoped names used by execution, saved calls and approval rules.
    const displayOnly = !context.runId && context.operationId === "connections.tools";
    return allowed
      .filter((row) =>
        selected?.some(
          (item) =>
            item.id === row.id && item.connectorId === ID && item.providerRef === row.providerRef,
        ),
      )
      .flatMap((row) =>
        scopeConnectorTools(TOOLS, {
          id: row.id,
          connectorId: ID,
          externalId: ID,
          displayName: row.displayName,
          providerRef: row.providerRef!,
        }).map((tool, index) => (displayOnly ? { ...tool, name: TOOLS[index]!.title } : tool)),
      );
  }
  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    try {
      const tool = (await this.discoverTools(context)).find(
        (item) =>
          (item.name === call.tool || item.route?.toolName === call.tool) &&
          item.route?.connectionId === call.route?.connectionId,
      );
      if (!tool?.route?.connectionId || typeof tool.route.resourceRevision !== "string")
        throw new CreativeServiceError("forbidden", 403);
      const identity = await this.authorize(
        context,
        tool.route.connectionId,
        tool.route.resourceRevision,
      );
      let data: unknown;
      switch (tool.route.toolName) {
        case "creative_capabilities": {
          const query = capabilitiesQuerySchema.safeParse(call.args);
          if (!query.success) throw new CreativeServiceError("invalid_parameters", 422);
          const catalog = await this.provider.capabilities(identity, context.signal);
          const models = catalog.models.filter(
            (model) =>
              (!query.data.kind || model.kind === query.data.kind) &&
              (!query.data.model || model.id === query.data.model),
          );
          if (query.data.model && !models.length)
            throw new CreativeServiceError("selection_unavailable", 422);
          const availability = {
            availableKinds: Object.fromEntries(
              creativeKindSchema.options.map((kind) => [
                kind,
                catalog.models.filter((model) => model.kind === kind).length,
              ]),
            ),
            defaults: Object.fromEntries(
              Object.entries(catalog.defaults).filter(([, id]) =>
                models.some((model) => model.id === id),
              ),
            ),
          };
          if (query.data.model) {
            data = {
              ...availability,
              ...(catalog.submission ? { submission: catalog.submission } : {}),
              models,
            };
            if (JSON.stringify(data).length > TOOL_RESULT_TEXT_LIMIT)
              throw new CreativeServiceError("capabilities_too_large");
          } else {
            const offset = query.data.offset ?? 0;
            if (offset > models.length) throw new CreativeServiceError("invalid_parameters", 422);
            const page = {
              ...availability,
              total: models.length,
              offset,
              nextOffset: null as number | null,
              models: [] as Array<
                Pick<CreativeCapabilities["models"][number], "id" | "name" | "kind">
              >,
            };
            for (let index = offset; index < models.length; index++) {
              const { id, name, kind } = models[index]!;
              page.models.push({ id, ...(name === undefined ? {} : { name }), kind });
              page.nextOffset = index + 1 < models.length ? index + 1 : null;
              if (JSON.stringify(page).length > TOOL_RESULT_TEXT_LIMIT) {
                page.models.pop();
                page.nextOffset = index;
                break;
              }
            }
            data = page;
          }
          break;
        }
        case "creative_submit": {
          const parsed = creativeToolInputSchema.safeParse(call.args);
          if (!parsed.success) throw new CreativeServiceError("invalid_parameters", 422);
          data = await this.creativeJobs.submit(
            context,
            call.executionId,
            tool.route.connectionId,
            tool.route.resourceRevision,
            parsed.data,
          );
          break;
        }
        case "creative_result": {
          if (typeof call.args.operationId !== "string")
            throw new CreativeServiceError("invalid_parameters", 422);
          data = await this.creativeJobs.result(
            context,
            call.args.operationId,
            tool.route.resourceRevision,
          );
          break;
        }
        default:
          throw new CreativeServiceError("forbidden", 403);
      }
      yield { type: "result", data };
    } catch (error) {
      yield {
        type: "error",
        message:
          error instanceof CreativeServiceError ? error.message : "Creative app: unavailable",
      };
    }
  }
}
