import * as z from "zod";
import { SpaceAvailabilitySchema } from "../account/space-availability.js";
import { Id } from "../ids.js";

export const CapabilityInstallSchema = z.object({
  id: Id,
  kind: z.enum(["skill", "plugin", "mcp", "api", "graphql", "connection"]),
  name: z.string(),
  source: z.string(),
  version: z.string().nullable(),
  digest: z.string().nullable(),
  secretConfigured: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  availability: SpaceAvailabilitySchema.optional(),
  createdAt: z.string(),
});
export type CapabilityInstall = z.infer<typeof CapabilityInstallSchema>;

export const PluginPreviewSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Paths of the reference files that install with the skill. */
  files: z.array(z.string()).optional(),
});
export const PluginPreviewMcpServerSchema = z.object({
  name: z.string(),
  transport: z.enum(["streamable_http", "sse"]),
  endpoint: z.string(),
  staticHeaderKeys: z.array(z.string()),
});
export const PluginPreviewSkippedSchema = z.object({
  kind: z.enum([
    "mcp_stdio",
    "mcp_invalid",
    "skill_invalid",
    "editor_only",
    "unsupported_transport",
    "unsupported_field",
  ]),
  name: z.string(),
  reason: z.string(),
});
export const PluginPreviewSchema = z.object({
  format: z.enum(["agent-plugins", "cursor", "grok"]),
  name: z.string(),
  version: z.string().nullable(),
  description: z.string(),
  author: z.string().nullable(),
  homepage: z.string().nullable(),
  repository: z.string().nullable(),
  license: z.string().nullable(),
  keywords: z.array(z.string()),
  resolvedSha: z.string().regex(/^[a-f0-9]{40}$/),
  /** Immutable source for confirming this preview, present on new API responses. */
  pinnedSource: z.string().optional(),
  /** The source an install of this preview is saved under. */
  installedSource: z.string().optional(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  skills: z.array(PluginPreviewSkillSchema),
  mcpServers: z.array(PluginPreviewMcpServerSchema),
  skipped: z.array(PluginPreviewSkippedSchema),
  /** Skills left out because a built-in skill has the same name; clients released before it ignore it. */
  builtinNames: z.array(z.string()).optional(),
});
export type PluginPreview = z.infer<typeof PluginPreviewSchema>;

/** A plugin installs as up to two independent parts: its MCP connector and its skills. */
export const PluginPartSchema = z.enum(["connector", "skills"]);
export type PluginPart = z.infer<typeof PluginPartSchema>;

export const PluginMarketplaceEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  keywords: z.array(z.string()),
  category: z.string().nullable(),
  logo: z.string().nullable(),
  homepage: z.string().nullable(),
  domains: z.array(z.string()),
  registry: z.string(),
  source: z.string(),
  installedSource: z.string(),
  /** Whether installing adds a remote MCP connector; plugins without one are skill packs. */
  hasConnector: z.boolean(),
  /** Skills, sub-agents and commands, which all install as skills. */
  skillCount: z.number().int().nonnegative(),
});
export type PluginMarketplaceEntry = z.infer<typeof PluginMarketplaceEntrySchema>;
export const PluginMarketplaceCatalogSchema = z.object({
  entries: z.array(PluginMarketplaceEntrySchema),
  unavailableRegistries: z.array(z.string()),
  skippedEntries: z.number().int().nonnegative(),
});
export type PluginMarketplaceCatalog = z.infer<typeof PluginMarketplaceCatalogSchema>;

export const PLUGIN_SUBMISSIONS_PATH = "/api/v1/plugin-submissions";
/** Approved claims, public so the marketing site can show each owner's page at build time. */
export const INTEGRATION_CLAIMS_PATH = "/api/v1/integration-claims";
/** Opened from the email that proves a claimant reads mail at the app's domain. */
export const INTEGRATION_CLAIM_CONFIRM_PATH = "/api/v1/integration-claims/confirm";
export const SUBMIT_PLUGIN_URL = "https://rakazo.com/plugins/submit/";
export const integrationPageUrl = (slug: string) => `https://rakazo.com/integrations/${slug}/`;

/** People type a bare domain like `acme.com`, so a URL without a scheme gets `https://`. */
const HttpsUrlSchema = z
  .string()
  .trim()
  .transform((value) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`))
  .pipe(
    z
      .string()
      .max(2048)
      .url()
      .refine((value) => value.startsWith("https://"), "Use an https:// URL"),
  );

export const PluginSubmissionInputSchema = z.object({
  email: z.string().trim().max(254).email(),
  name: z.string().trim().min(1).max(80),
  website: HttpsUrlSchema.optional(),
  logo: HttpsUrlSchema,
  source: HttpsUrlSchema,
  description: z.string().trim().min(1).max(2000),
  testing: z.string().trim().min(1).max(4000),
  tested: z.literal(true),
});

/** An app's owner claiming its integration page so it links to their site. */
export const IntegrationClaimInputSchema = z.object({
  /** The page's URL slug, as in `integrationPageUrl`. */
  claim: z
    .string()
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Use the page's URL slug"),
  email: z.string().trim().max(254).email(),
  name: z.string().trim().min(1).max(80),
  website: HttpsUrlSchema,
});

export const IntegrationClaimSchema = z.object({
  slug: z.string(),
  website: z.string(),
});
export type IntegrationClaim = z.infer<typeof IntegrationClaimSchema>;

export const PluginSubmissionStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type PluginSubmissionStatus = z.infer<typeof PluginSubmissionStatusSchema>;

export const PluginSubmissionSchema = PluginSubmissionInputSchema.omit({ tested: true }).extend({
  id: z.string(),
  website: z.string().nullable(),
  logo: z.string().nullable(),
  source: z.string().nullable(),
  testing: z.string().nullable(),
  /** Empty for a claim, which only links the page. */
  description: z.string(),
  /** The integration page URL slug a claim is for; null for plugins. */
  claim: z.string().nullable(),
  status: PluginSubmissionStatusSchema,
  reason: z.string().nullable(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
});
export type PluginSubmission = z.infer<typeof PluginSubmissionSchema>;

export const PluginSubmissionReviewSchema = z.discriminatedUnion("decision", [
  z.object({ id: Id, decision: z.literal("approve") }),
  z.object({ id: Id, decision: z.literal("reject"), reason: z.string().trim().min(1).max(1000) }),
]);
export type PluginSubmissionReview = z.infer<typeof PluginSubmissionReviewSchema>;
