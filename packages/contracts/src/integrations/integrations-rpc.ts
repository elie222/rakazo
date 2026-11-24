import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { botId } from "../rpc/inputs.js";
import { settingsScopeInput } from "../settings-scope.js";
import { AppConnectClientSchema, AppConnectOriginSchema } from "./app-connect-return.js";
import {
  ActionApprovalRuleSchema,
  ActionAutoReviewSettingsSchema,
  ApprovalModeSchema,
} from "./approvals.js";
import {
  CATALOG_SEARCH_QUERY_MAX_LENGTH,
  ConnectionCatalogItemSchema,
  ConnectionLabelSchema,
  ConnectionSchema,
  IntegrationCatalogResultSchema,
} from "./connections.js";
import {
  IntegrationProviderConfigSchema,
  IntegrationSetupStateSchema,
} from "./integration-settings.js";
import {
  BotMcpServerSchema,
  McpRemoteEndpointSchema,
  McpServerConfigInput,
  McpServerSchema,
  McpSourcePresetSchema,
} from "./mcp.js";
import { McpCapturesLoopbackSchema, McpOAuthClientKindSchema } from "./mcp-oauth-return.js";
import {
  MessagingAgentConnectionSchema,
  MessagingChannelMembershipSchema,
  MessagingInstallationsStatusSchema,
  MessagingLinkedIdentitySchema,
  MessagingStatusSchema,
} from "./messaging.js";
import {
  CapabilityInstallSchema,
  PluginMarketplaceCatalogSchema,
  PluginPartSchema,
  PluginPreviewSchema,
  PluginSubmissionReviewSchema,
  PluginSubmissionSchema,
  PluginSubmissionStatusSchema,
} from "./plugins.js";

const McpOAuthBeginSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("authorization_required"),
    sessionId: Id,
    authorizationUrl: z.string().url(),
  }),
  z.object({ status: z.enum(["already_connected", "authorization_not_requested"]) }),
]);

/** Which agents can use an MCP server: all of them, or only `botIds`. */
const McpServerAccessInput = z.object({
  allBots: z.boolean(),
  botIds: z.array(Id).max(500).default([]),
});

export const integrationsRpc = {
  marketplace: {
    catalog: oc
      .input(z.object({ query: z.string().trim().max(200).default("") }))
      .output(PluginMarketplaceCatalogSchema),
    /** Admins only. */
    submissions: oc
      .input(z.object({ status: PluginSubmissionStatusSchema.default("pending") }))
      .output(z.array(PluginSubmissionSchema)),
    /** Admins only. */
    review: oc.input(PluginSubmissionReviewSchema).output(PluginSubmissionSchema),
  },
  capabilities: {
    list: oc.output(z.array(CapabilityInstallSchema)),
    sourcePresets: oc.output(z.array(McpSourcePresetSchema)),
    catalogSearch: oc
      .input(
        z.object({
          query: z.string().trim().max(CATALOG_SEARCH_QUERY_MAX_LENGTH).default(""),
          usePublicCatalog: z.boolean().default(false),
        }),
      )
      .output(
        z.object({
          enabled: z.boolean(),
          results: z.array(IntegrationCatalogResultSchema),
        }),
      ),
    install: oc
      .input(
        z.object({
          kind: z.enum(["skill", "plugin", "mcp", "api", "graphql"]),
          name: z.string().min(1).max(120),
          source: z.string().min(1).max(2048),
          config: z.record(z.string(), z.unknown()).default({}),
          credential: z.string().max(16_384).optional(),
          /** Required for plugins: confirms the exact previewed package content. */
          pluginDigest: z
            .string()
            .regex(/^sha256:[a-f0-9]{64}$/)
            .optional(),
          /** Plugins only: which parts to add; all supported parts when omitted. */
          pluginParts: z.array(PluginPartSchema).min(1).max(2).optional(),
        }),
      )
      .output(CapabilityInstallSchema),
    /** Add or remove parts of an installed plugin at its pinned version; no parts removes it. */
    pluginParts: oc
      .input(z.object({ id: Id, parts: z.array(PluginPartSchema).max(2) }))
      .output(z.object({ install: CapabilityInstallSchema.nullable() })),
    /** Fetch and parse a plugin repo without installing: shows the skills,
     * MCP endpoints, variables, and skipped parts before confirmation. */
    pluginPreview: oc
      .input(z.object({ source: z.string().min(1).max(2048) }))
      .output(PluginPreviewSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  mcp: {
    servers: {
      list: oc.output(z.array(McpServerSchema)),
      create: oc.input(McpServerConfigInput).output(McpServerSchema),
      /** `create` for only the chosen agents, so a server too old to know them rejects it
       * instead of adding a server every agent can use. */
      createForBots: oc
        .input(
          z.object({ config: McpServerConfigInput, botIds: McpServerAccessInput.shape.botIds }),
        )
        .output(McpServerSchema),
      /** Adds a remote server by URL, or reuses the one already added, and starts its sign-in.
       * The bot gets the server once the sign-in finishes, or at once when none is needed. */
      connect: oc
        .input(
          z.object({
            name: z.string().trim().min(1).max(120),
            endpoint: McpRemoteEndpointSchema,
            botId: Id.optional(),
            redirectUri: z.string().url().optional(),
            client: McpOAuthClientKindSchema,
            capturesLoopback: McpCapturesLoopbackSchema,
          }),
        )
        .output(z.object({ server: McpServerSchema, signIn: McpOAuthBeginSchema })),
      update: oc
        .input(
          z.union([
            z.object({ id: Id, config: McpServerConfigInput }),
            z.object({ id: Id, secret: z.string().min(1).max(16384) }),
          ]),
        )
        .output(McpServerSchema),
      /** `update` with which agents can use the server, saved in one transaction. */
      save: oc
        .input(z.object({ id: Id, config: McpServerConfigInput, access: McpServerAccessInput }))
        .output(McpServerSchema),
      remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
      /** Launch the server once (installing a stdio package if needed), list its tools, close it. */
      test: oc.input(z.object({ id: Id })).output(McpServerSchema),
      /** Which agents can use the server: all of them, or only `botIds`. */
      agents: oc
        .input(z.object({ id: Id }).merge(McpServerAccessInput))
        .output(z.object({ server: McpServerSchema, assignments: z.array(BotMcpServerSchema) })),
    },
    assignments: {
      list: oc.input(botId).output(z.array(BotMcpServerSchema)),
      all: oc.output(z.array(BotMcpServerSchema)),
      approve: oc
        .input(z.object({ botId: Id, serverId: Id, threadId: Id.optional() }))
        .output(BotMcpServerSchema),
      dismiss: oc
        .input(z.object({ botId: Id, serverId: Id, threadId: Id.optional() }))
        .output(z.object({ ok: z.literal(true) })),
      replace: oc
        .input(
          z.object({
            botId: Id,
            assignments: z.array(
              z.object({
                serverId: Id,
                allowAllTools: z.boolean().default(true),
                allowedTools: z.array(z.string().min(1).max(200)).max(500).default([]),
              }),
            ),
          }),
        )
        .output(z.array(BotMcpServerSchema)),
    },
    oauth: {
      begin: oc
        .input(
          z.object({
            serverId: Id,
            redirectUri: z.string().url().optional(),
            client: McpOAuthClientKindSchema,
            capturesLoopback: McpCapturesLoopbackSchema,
          }),
        )
        .output(McpOAuthBeginSchema),
      complete: oc
        .input(z.object({ sessionId: Id, code: z.string().min(1), state: z.string().min(1) }))
        .output(z.object({ ok: z.literal(true) })),
      disconnect: oc.input(z.object({ serverId: Id })).output(z.object({ ok: z.literal(true) })),
    },
  },
  integrationSetup: {
    get: oc.output(IntegrationSetupStateSchema),
    save: oc.input(IntegrationProviderConfigSchema).output(z.object({ ok: z.literal(true) })),
  },
  connections: {
    catalog: oc
      .input(z.object({ query: z.string().optional(), connectorId: z.string().optional() }))
      .output(z.array(ConnectionCatalogItemSchema)),
    list: oc.output(z.array(ConnectionSchema)),
    begin: oc
      .input(
        z.object({
          /** Omitted for the server's default connector. */
          connectorId: z.string().optional(),
          provider: z.string(),
          displayName: ConnectionLabelSchema,
          /** The chat card connecting the app, which the server updates once the sign-in ends. */
          origin: AppConnectOriginSchema.optional(),
          client: AppConnectClientSchema,
        }),
      )
      .output(z.object({ connectionId: Id, authorizationUrl: z.string().nullable() })),
    complete: oc
      .input(z.object({ connectionId: Id, code: z.string().optional() }))
      .output(ConnectionSchema),
    rename: oc
      .input(
        z.object({
          connectionId: Id,
          displayName: ConnectionLabelSchema,
        }),
      )
      .output(ConnectionSchema),
    revoke: oc.input(z.object({ connectionId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Tools the connected provider exposes. Read-only; no per-tool allowlist yet. */
    tools: oc.input(z.object({ connectorId: z.string(), provider: z.string() })).output(
      z.array(
        z.object({
          name: z.string(),
          description: z.string(),
        }),
      ),
    ),
  },
  /** External messaging surface: link state, group channels, agent connections. */
  messaging: {
    installations: {
      list: oc.output(MessagingInstallationsStatusSchema),
      /** Without a bot, the workspace answers as the first bot in the user's default space. */
      start: oc.input(z.object({ botId: Id.optional() })).output(z.object({ url: z.string() })),
      complete: oc
        .input(z.object({ state: z.string().max(64), code: z.string().max(4096) }))
        .output(z.object({ ok: z.literal(true) })),
      remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
    },
    status: oc.output(MessagingStatusSchema),
    link: {
      /** Issue a short-lived code the user sends to the line from a chat app. */
      start: oc.input(z.object({ botId: Id })).output(
        z.object({
          code: z.string(),
          expiresAt: z.string(),
          /** Others share the bot's Space, so they can read the chats this link brings in. */
          shared: z.boolean().optional(),
        }),
      ),
    },
    identities: {
      setBot: oc
        .input(z.object({ identityId: Id, botId: Id }))
        .output(MessagingLinkedIdentitySchema),
      unlink: oc.input(z.object({ identityId: Id })).output(z.object({ ok: z.literal(true) })),
    },
    channels: {
      list: oc.output(z.array(MessagingChannelMembershipSchema)),
      // Addressed by membership, not channel: one user can have two linked
      // chat apps in the same group, and each answers for its own agent.
      respond: oc
        .input(z.object({ membershipId: Id, accept: z.boolean() }))
        .output(MessagingChannelMembershipSchema),
      leave: oc.input(z.object({ membershipId: Id })).output(z.object({ ok: z.literal(true) })),
    },
    connections: {
      list: oc.output(z.array(MessagingAgentConnectionSchema)),
      respond: oc
        .input(z.object({ connectionId: Id, accept: z.boolean() }))
        .output(MessagingAgentConnectionSchema),
      revoke: oc.input(z.object({ connectionId: Id })).output(z.object({ ok: z.literal(true) })),
    },
  },
  approvalRules: {
    list: oc.input(settingsScopeInput.optional()).output(z.array(ActionApprovalRuleSchema)),
    set: oc
      .input(
        settingsScopeInput.extend({
          effect: z.enum(["always_allow", "require_approval", "deny"]),
          matchKind: z.enum(["tool", "connector", "site"]),
          matchValue: z.string().trim().min(1),
        }),
      )
      .output(ActionApprovalRuleSchema),
    remove: oc
      .input(settingsScopeInput.extend({ id: Id }))
      .output(z.object({ ok: z.literal(true) })),
  },
  /**
   * Sites the signed-in user opens from chat links without the external-link prompt, in every
   * space. The server computes each site from a link; bot fetches never read this list.
   */
  trustedLinkSites: {
    list: oc.output(z.array(z.string())),
    trust: oc
      .input(z.object({ url: z.string().min(1).max(8192) }))
      .output(z.object({ site: z.string() })),
    remove: oc
      .input(z.object({ site: z.string().min(1).max(253) }))
      .output(z.object({ ok: z.literal(true) })),
  },
  autoReview: {
    get: oc.input(settingsScopeInput.optional()).output(ActionAutoReviewSettingsSchema),
    set: oc
      .input(
        settingsScopeInput.extend({
          mode: ApprovalModeSchema.optional(),
          enabled: z.boolean().optional(),
          skipApprovals: z.boolean().optional(),
        }),
      )
      .output(ActionAutoReviewSettingsSchema),
  },
};
