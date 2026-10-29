import { ORPCError } from "@orpc/server";
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { parsePluginSource, previewPluginInstall } from "@rakazo/adapters";
import {
  pluginSubmissionAdminEmail,
  pluginSubmissionReceivedEmail,
  pluginSubmissionReviewedEmail,
} from "@rakazo/auth";
import type {
  PluginMarketplaceEntry,
  PluginSubmission,
  PluginSubmissionReview,
  PluginSubmissionStatus,
} from "@rakazo/contracts";
import { PLUGIN_SUBMISSIONS_PATH, PluginSubmissionInputSchema } from "@rakazo/contracts";
import { pluginCategory } from "@rakazo/core";
import type { PluginSubmission as PluginSubmissionRow, PrismaClient } from "@rakazo/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";
import { assertMcpRemoteEndpoint } from "./mcp-servers.js";
import { hasBuiltinSkillName } from "./plugin-installs.js";
import type { RouterDeps } from "./router.js";
import { windowCounter } from "./window-counter.js";

const PLUGIN_REGISTRY = "Rakazo";
const MAX_BODY_BYTES = 32 * 1024;
const HOUR_MS = 60 * 60_000;
const SUBMISSIONS_PER_IP_PER_HOUR = 10;
// Anyone can type any address, so one inbox gets at most a few confirmations a day.
const CONFIRMATIONS_PER_EMAIL_PER_DAY = 3;

type EmailDeps = Pick<RouterDeps, "email" | "onEmailError">;
type SourceRef = ReturnType<typeof parsePluginSource>;

// The provider tracks the send, so shutdown drains it; requests do not wait on delivery.
function sendLater({ email, onEmailError }: EmailDeps, message: Promise<TransactionalEmail>) {
  if (email) void message.then((built) => email.send(built)).catch((e) => onEmailError?.(e));
}

export async function isAdmin(
  deps: Pick<RouterDeps, "prisma" | "env">,
  userId: string,
): Promise<boolean> {
  const admins = deps.env.adminEmails ?? [];
  if (admins.length === 0) return false;
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  return Boolean(user?.emailVerified && admins.includes(user.email.toLowerCase()));
}

function sourceString(ref: SourceRef, pin: string | undefined): string {
  return ref.gitUrl + (pin ? `@${pin}` : "") + (ref.subdir ? `#${ref.subdir}` : "");
}

function browseUrl(source: string): string {
  const ref = parsePluginSource(source);
  return ref.ref || ref.subdir
    ? `${ref.gitUrl}/tree/${ref.ref ?? "HEAD"}${ref.subdir ? `/${ref.subdir}` : ""}`
    : ref.gitUrl;
}

function pluginSubmissionDto(row: PluginSubmissionRow): PluginSubmission {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    website: row.website,
    logo: row.logo,
    source: browseUrl(row.source),
    description: row.description,
    testing: row.testing,
    status: row.status as PluginSubmissionStatus,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

export function pluginSubmissionRoutes(
  deps: EmailDeps & {
    prisma: PrismaClient;
    adminEmails: readonly string[];
    webOrigin: string;
    clientIp: (c: Context) => string | undefined;
  },
) {
  const app = new Hono();
  const submissions = windowCounter(HOUR_MS);
  const confirmations = windowCounter(24 * HOUR_MS);
  const invalid = (c: Context, issues: Array<{ field: string; message: string }>) =>
    c.json({ error: "Invalid submission", issues }, 400);

  app.post(PLUGIN_SUBMISSIONS_PATH, async (c) => {
    if (submissions(`ip:${deps.clientIp(c) ?? "unknown"}`) > SUBMISSIONS_PER_IP_PER_HOUR) {
      return c.json({ error: "Too many submissions. Try again later." }, 429, {
        "retry-after": String(HOUR_MS / 1000),
      });
    }
    const text = await readBoundedBody(c.req.raw, MAX_BODY_BYTES);
    if (text === null) return c.json({ error: "Submission is too large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "Send the submission as JSON" }, 400);
    }
    const parsed = PluginSubmissionInputSchema.safeParse(body);
    if (!parsed.success) {
      return invalid(
        c,
        parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    const { tested: _tested, ...input } = parsed.data;
    let source: string;
    try {
      const ref = parsePluginSource(input.source);
      if (new URL(ref.gitUrl).hostname !== "github.com")
        throw new Error("Use a public GitHub repository");
      source = sourceString(ref, ref.ref);
    } catch (error) {
      return invalid(c, [{ field: "source", message: (error as Error).message }]);
    }
    const email = input.email.toLowerCase();
    const data = { ...input, email, source, website: input.website ?? null };
    // The same author resubmitting while it waits updates theirs; anyone else's is kept apart.
    const pending = await deps.prisma.pluginSubmission.findFirst({
      where: { source, email, status: "pending" },
      select: { id: true },
    });
    // A submission reviewed since the lookup keeps what the admin saw; this becomes a new one.
    const updated =
      pending &&
      (
        await deps.prisma.pluginSubmission.updateMany({
          where: { id: pending.id, status: "pending" },
          data,
        })
      ).count > 0;
    const row = updated
      ? await deps.prisma.pluginSubmission.findUniqueOrThrow({ where: { id: pending.id } })
      : await deps.prisma.pluginSubmission.create({ data });
    if (confirmations(email) <= CONFIRMATIONS_PER_EMAIL_PER_DAY) {
      sendLater(deps, pluginSubmissionReceivedEmail(email));
    }
    if (!updated) {
      const reviewUrl = new URL("/admin/plugins", deps.webOrigin).href;
      for (const admin of deps.adminEmails) {
        sendLater(deps, pluginSubmissionAdminEmail(admin, row, reviewUrl));
      }
    }
    return c.json({ id: row.id, status: row.status }, updated ? 200 : 201);
  });

  return app;
}

export async function listPluginSubmissions(
  prisma: PrismaClient,
  status: PluginSubmissionStatus,
): Promise<PluginSubmission[]> {
  const rows = await prisma.pluginSubmission.findMany({
    where: { status },
    orderBy: { createdAt: status === "pending" ? "asc" : "desc" },
    take: 200,
  });
  return rows.map(pluginSubmissionDto);
}

export async function reviewPluginSubmission(
  deps: EmailDeps & Pick<RouterDeps, "prisma" | "pluginRepoFetcher" | "remoteConnectors" | "env">,
  input: PluginSubmissionReview,
  signal?: AbortSignal,
): Promise<PluginSubmission> {
  const row = await deps.prisma.pluginSubmission.findUnique({ where: { id: input.id } });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Submission not found" });
  if (row.status !== "pending") throw new ORPCError("CONFLICT", { message: "Already reviewed" });
  let listing = {};
  if (input.decision === "approve") {
    // Approval lists the commit that was checked, the same way the other registries pin theirs.
    const preview = await previewPluginInstall({
      source: row.source,
      signal,
      fetcher: deps.pluginRepoFetcher,
    }).catch(() => {
      throw new ORPCError("BAD_REQUEST", {
        message: "Could not preview a supported plugin from this repository",
      });
    });
    for (const server of preview.mcpServers) await assertMcpRemoteEndpoint(server.endpoint, deps);
    if (preview.skipped.some((part) => part.kind !== "unsupported_field")) {
      throw new ORPCError("BAD_REQUEST", { message: "This plugin would only install in part" });
    }
    if (!preview.skills.length && !preview.mcpServers.length) {
      throw new ORPCError("BAD_REQUEST", { message: "This plugin has no skills or MCP servers" });
    }
    if (hasBuiltinSkillName(preview.skills)) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Plugin skill conflicts with a built-in skill",
      });
    }
    listing = {
      pinnedSource: sourceString(preview.source, preview.resolvedSha),
      hasConnector: preview.mcpServers.length > 0,
      skillCount: preview.skills.length,
    };
  }
  const status = input.decision === "approve" ? "approved" : "rejected";
  const reason = input.decision === "reject" ? input.reason : null;
  // During the preview another admin may decide or the author may resubmit; only the reviewed
  // version is decided, once.
  const decided = await deps.prisma.pluginSubmission.updateMany({
    where: { id: row.id, status: "pending", updatedAt: row.updatedAt },
    data: { ...listing, status, reason, reviewedAt: new Date() },
  });
  if (decided.count === 0)
    throw new ORPCError("CONFLICT", { message: "Changed or already reviewed. Reload to see it." });
  sendLater(
    deps,
    pluginSubmissionReviewedEmail({ email: row.email, name: row.name, status, reason }),
  );
  return pluginSubmissionDto(
    await deps.prisma.pluginSubmission.findUniqueOrThrow({ where: { id: row.id } }),
  );
}

/** Newest approval per repository and folder. */
export async function approvedPluginEntries(
  prisma: PrismaClient,
): Promise<PluginMarketplaceEntry[]> {
  const rows = await prisma.pluginSubmission.findMany({
    where: { status: "approved", pinnedSource: { not: null } },
    orderBy: { reviewedAt: "desc" },
  });
  const listed = new Set<string>();
  return rows.flatMap((row) => {
    const source = row.pinnedSource!;
    const installedSource = sourceString(parsePluginSource(source), undefined);
    if (listed.has(installedSource)) return [];
    listed.add(installedSource);
    const name = row.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return [
      {
        id: `${PLUGIN_REGISTRY}:${source}`,
        name,
        displayName: row.name,
        description: row.description,
        keywords: [],
        category: pluginCategory({ name, category: null }),
        logo: row.logo,
        homepage: row.website,
        domains: [],
        registry: PLUGIN_REGISTRY,
        source,
        installedSource,
        hasConnector: row.hasConnector,
        skillCount: row.skillCount,
      },
    ];
  });
}
