import { ORPCError } from "@orpc/server";
import {
  effectiveModelRole,
  hasHostedModelCredits,
  isAutoReviewCheckerConfigured,
  PushSessionEndedError,
} from "@rakazo/adapters";
import type { ActionApprovalRule, Actor, Me, SettingsScope } from "@rakazo/contracts";
import { approvalModeFromPreference, approvalPreferenceFromMode } from "@rakazo/core";
import { urlSite } from "@rakazo/core/egress";
import {
  auditLogOrganization,
  findAutoReviewPreference,
  findDefaultVoiceCredential,
  findModelCredential,
  findModelCredentialById,
  listApprovalRules,
  listAuditEvents,
  listVoicePreferences,
  lockSpaceSettings,
  newestVoiceCredentialOrder,
  Prisma,
  removeApprovalRule,
  runAsSystem,
  saveApprovalRule,
  saveAutoReviewPreference,
  selectVoicePreference,
  voicePreferenceTarget,
} from "@rakazo/db";
import { aiConsentStatus, allowAiConsent } from "../ai-consent.js";
import type { BillingService } from "../billing.js";
import { firstModelConnectAnalytics } from "../model-connect-analytics.js";
import type { RouterDeps } from "../router.js";
import { withSerializableRetry } from "../serializable-retry.js";
import {
  disconnectVoiceCredential,
  listVoiceCatalog,
  loadDefaultVoiceCredential,
  loadVoiceCredential,
  persistVoiceCredential,
  prepareVoice,
  toVoiceCredential,
  toVoiceStatus,
  updateVoiceSpeechModel,
  voiceContext,
  voiceCredentialServer,
  voiceProviderFor,
} from "../voice.js";
import type { RouterContext } from "./context.js";
import { meDto } from "./shared.js";

export function accountRoutes(ctx: RouterContext) {
  const { deps, os, authed } = ctx;
  return {
    aiConsent: {
      status: authed.aiConsent.status.handler(({ context, input }) =>
        aiConsentStatus(deps, context.actor, input),
      ),
      allow: authed.aiConsent.allow.handler(({ context, input }) =>
        allowAiConsent(deps, context.actor, input),
      ),
      revoke: authed.aiConsent.revoke.handler(async ({ context, input }) => {
        await deps.prisma.aiDataConsent.deleteMany({
          where: {
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            recipientKey: input.key ?? undefined,
          },
        });
        return aiConsentStatus(deps, context.actor);
      }),
    },
    analytics: {
      screen: authed.analytics.screen.handler(async ({ context, input }) => {
        deps.analytics?.capture(context.actor.userId, { name: "screen_viewed", ...input });
        return { ok: true as const };
      }),
    },
    health: os.health.handler(async () => ({ ok: true as const, version: "0.1.0" })),
    me: authed.me.handler(async ({ context }): Promise<Me> => meDto(deps, context.actor)),
    billing: {
      selectFunding: authed.billing.selectFunding.handler(async ({ context, input }) => {
        const billing = requireBilling(deps);
        if (input.funding === "credits") {
          const record = await firstModelConnectAnalytics(deps, context.actor, "credits");
          record(undefined, { name: "model_connect_started" });
        }
        return billing.selectFunding(context.actor, input.funding, input.client);
      }),
      purchaseCredits: authed.billing.purchaseCredits.handler(async ({ context, input }) =>
        requireBilling(deps).purchaseCredits(context.actor, input),
      ),
      setMonthlyCredits: authed.billing.setMonthlyCredits.handler(async ({ context, input }) =>
        requireBilling(deps).setMonthlyCredits(context.actor, input.amountCents),
      ),
      status: authed.billing.status.handler(async ({ context }) =>
        requireBilling(deps).status(context.actor),
      ),
      refresh: authed.billing.refresh.handler(async ({ context }) => {
        const billing = requireBilling(deps);
        await billing.syncForActor(context.actor);
        return billing.status(context.actor);
      }),
      checkout: authed.billing.checkout.handler(async ({ context, input }) =>
        requireBilling(deps).checkout(context.actor, input?.client),
      ),
      portal: authed.billing.portal.handler(async ({ context, input }) =>
        requireBilling(deps).portal(context.actor, input?.client),
      ),
      claimReferral: authed.billing.claimReferral.handler(async ({ context, input }) => {
        await requireBilling(deps).claimReferral(context.actor, input.code);
        return { ok: true as const };
      }),
    },
    preferences: {
      update: authed.preferences.update.handler(async ({ context, input }): Promise<Me> => {
        await deps.prisma.user.update({
          where: { id: context.actor.userId },
          // An avatar style from an older app is accepted and ignored: there is only one.
          data: input.timezone === undefined ? {} : { timezone: input.timezone },
        });
        return meDto(deps, context.actor);
      }),
      adoptTimezone: authed.preferences.adoptTimezone.handler(
        async ({ context, input }): Promise<Me> => {
          // Conditional in one statement: a concurrent explicit save always wins.
          await deps.prisma.user.updateMany({
            where: { id: context.actor.userId, timezone: null },
            data: { timezone: input.timezone },
          });
          return meDto(deps, context.actor);
        },
      ),
    },
    // Retain wire compatibility for older clients, but app accounts have no server authority.
    deployment: {
      get: authed.deployment.get.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
      update: authed.deployment.update.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
    },
    security: {
      events: authed.security.events.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
    },
    audit: {
      events: authed.audit.events.handler(async ({ context, input }) => {
        const organizationId = await auditLogOrganization(deps.prisma, context.actor);
        if (!organizationId) throw new ORPCError("FORBIDDEN");
        return runAsSystem("read the organization's audit log", () =>
          listAuditEvents(deps.prisma, organizationId, input),
        );
      }),
    },
    updater: {
      status: authed.updater.status.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
      check: authed.updater.check.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
      apply: authed.updater.apply.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
    },
    approvalRules: {
      list: authed.approvalRules.list.handler(async ({ context, input }) => {
        const rows = await listApprovalRules(deps.prisma, context.actor, input?.scope);
        return rows.map(approvalRuleDto);
      }),
      set: authed.approvalRules.set.handler(async ({ context, input }) => {
        const { scope, ...rule } = input;
        return approvalRuleDto(
          await deps.prisma.$transaction((tx) => saveApprovalRule(tx, context.actor, rule, scope)),
        );
      }),
      remove: authed.approvalRules.remove.handler(async ({ context, input }) => {
        await deps.prisma.$transaction((tx) =>
          removeApprovalRule(tx, context.actor, input.id, input.scope),
        );
        return { ok: true as const };
      }),
    },
    // The user's own list for the external-link prompt, kept apart from approval rules: a
    // trusted link site never lets a bot fetch, and a site rule never skips the prompt.
    trustedLinkSites: {
      list: authed.trustedLinkSites.list.handler(async ({ context }) => {
        const rows = await deps.prisma.trustedLinkSite.findMany({
          where: { userId: context.actor.userId },
          orderBy: { site: "asc" },
        });
        return rows.map((row) => row.site);
      }),
      trust: authed.trustedLinkSites.trust.handler(async ({ context, input }) => {
        // The server names the site, so the list only ever holds sites.
        const site = urlSite(input.url);
        if (!site) throw new ORPCError("BAD_REQUEST", { message: "Not a web link." });
        await deps.prisma.trustedLinkSite.createMany({
          data: { userId: context.actor.userId, site },
          skipDuplicates: true,
        });
        return { site };
      }),
      remove: authed.trustedLinkSites.remove.handler(async ({ context, input }) => {
        await deps.prisma.trustedLinkSite.deleteMany({
          where: { userId: context.actor.userId, site: input.site },
        });
        return { ok: true as const };
      }),
    },
    autoReview: {
      get: authed.autoReview.get.handler(async ({ context, input }) => {
        return loadAutoReviewSettings(deps, context.actor, input?.scope);
      }),
      set: authed.autoReview.set.handler(async ({ context, input }) => {
        await deps.prisma.$transaction((tx) =>
          saveAutoReviewPreference(
            tx,
            context.actor,
            input.mode
              ? approvalPreferenceFromMode(input.mode)
              : { enabled: input.enabled, skipApprovals: input.skipApprovals },
            { enabled: true, skipApprovals: false },
            input.scope,
          ),
        );
        return loadAutoReviewSettings(deps, context.actor, input.scope);
      }),
    },
    notifications: {
      registerPush: authed.notifications.registerPush.handler(async ({ context, input }) => {
        const sessionId = context.sessionId;
        if (!sessionId) throw new ORPCError("UNAUTHORIZED");
        try {
          await deps.pushTokens.save(context.actor.userId, input.token, sessionId);
        } catch (error) {
          if (error instanceof PushSessionEndedError) throw new ORPCError("UNAUTHORIZED");
          throw error;
        }
        return { ok: true as const };
      }),
      unregisterPush: authed.notifications.unregisterPush.handler(async ({ context }) => {
        await deps.pushTokens.remove(context.actor.userId);
        return { ok: true as const };
      }),
    },
    voice: {
      catalog: authed.voice.catalog.handler(async () =>
        listVoiceCatalog({ allowPrivateEndpoint: deps.env?.mcpAllowPrivateEndpoint }),
      ),
      status: authed.voice.status.handler(async ({ context, input }) => {
        const cred = await findDefaultVoiceCredential(deps.prisma, context.actor, input?.scope);
        return toVoiceStatus(cred);
      }),
      credentials: authed.voice.credentials.handler(async ({ context, input }) => {
        const target = await voicePreferenceTarget(deps.prisma, context.actor, input?.scope);
        const [rows, preferences] = await Promise.all([
          deps.prisma.userVoiceCredential.findMany({
            where: { userId: context.actor.userId },
            orderBy: newestVoiceCredentialOrder,
          }),
          listVoicePreferences(deps.prisma, target),
        ]);
        return Promise.all(
          rows.map(async (row) => {
            const preference = preferences.find((saved) => saved.credentialId === row.id);
            return toVoiceCredential({
              ...row,
              isDefault: preference?.isDefault ?? false,
              voiceId: preference?.voiceId ?? "",
              speechModel: preference?.speechModel ?? "",
              server: await voiceCredentialServer(deps, context.actor, row),
            });
          }),
        );
      }),
      connect: authed.voice.connect.handler(async ({ context, input }) =>
        persistVoiceCredential(deps, context.actor, {
          provider: input.provider,
          plaintext: input.apiKey,
          voiceId: input.voiceId,
          speechModel: input.speechModel,
          baseUrl: input.baseUrl,
          ttsModel: input.ttsModel,
          sttModel: input.sttModel,
          scope: input.scope,
          signal: context.signal,
        }),
      ),
      disconnect: authed.voice.disconnect.handler(async ({ context, input }) =>
        disconnectVoiceCredential(deps, context.actor, { provider: input.provider }),
      ),
      setVoice: authed.voice.setVoice.handler(async ({ context, input }) => {
        const cred = await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              await lockSpaceSettings(tx, context.actor);
              const target = await voicePreferenceTarget(tx, context.actor, input.scope);
              const found = input.provider
                ? await tx.userVoiceCredential.findFirst({
                    where: { userId: context.actor.userId, provider: input.provider },
                    orderBy: newestVoiceCredentialOrder,
                  })
                : await findDefaultVoiceCredential(tx, context.actor, target.scope);
              if (!found) {
                throw new ORPCError("BAD_REQUEST", { message: "Connect a voice provider first." });
              }
              // Picking a voice also makes its provider the one speak/transcribe use.
              await selectVoicePreference(tx, target, found.id, input.voiceId);
              return { ...found, voiceId: input.voiceId, isDefault: true };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        return toVoiceStatus(cred);
      }),
      setSpeechModel: authed.voice.setSpeechModel.handler(async ({ context, input }) =>
        updateVoiceSpeechModel(deps, context.actor, input),
      ),
      voices: authed.voice.voices.handler(async ({ context, input }) => {
        // A named provider lists its voices even before the copy has a default voice.
        const row = input.provider
          ? await loadVoiceCredential(deps, context.actor, input.provider, input.scope)
          : await loadDefaultVoiceCredential(deps, context.actor, input.scope);
        if (!row) return [];
        return (await voiceProviderFor(deps, context.actor, row.cred.provider)).listVoices(
          row.apiKey,
          voiceContext(context.actor, context.signal),
        );
      }),
      prepare: authed.voice.prepare.handler(async ({ context, input }) =>
        prepareVoice(deps, context.actor, { ...input, signal: context.signal }),
      ),
    },
  };
}

function approvalRuleDto(row: {
  id: string;
  effect: string;
  matchKind: string;
  matchValue: string;
  createdAt: Date;
}): ActionApprovalRule {
  return {
    id: row.id,
    effect: row.effect as ActionApprovalRule["effect"],
    matchKind: row.matchKind as ActionApprovalRule["matchKind"],
    matchValue: row.matchValue,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadAutoReviewSettings(deps: RouterDeps, actor: Actor, scope?: SettingsScope) {
  const [role, preference] = await Promise.all([
    // The account page judges the account's approval model; a Space, the one that applies there.
    effectiveModelRole(
      deps.prisma,
      actor,
      "approval",
      { env: process.env },
      scope === "account" ? "account" : undefined,
    ),
    findAutoReviewPreference(deps.prisma, actor, scope),
  ]);
  const stored = {
    enabled: preference?.enabled ?? true,
    skipApprovals: preference?.skipApprovals ?? false,
  };
  const settings = { ...stored, mode: approvalModeFromPreference(stored) };
  const deploymentChecker = role.primarySource === "deployment" ? role.primary : null;
  const memberChoices = [
    ...(deploymentChecker || !role.primary ? [] : [role.primary]),
    ...role.backups,
  ];
  const environmentAvailable = isAutoReviewCheckerConfigured({ env: process.env });
  if (memberChoices.length === 0) {
    // The deployment's checker runs on its own configuration or on the member's key for it.
    const requiredUserProvider =
      environmentAvailable || deploymentChecker?.provider === "scripted"
        ? null
        : deploymentChecker?.provider;
    const credential = requiredUserProvider
      ? await deps.prisma.userModelCredential.findFirst({
          where: { userId: actor.userId, provider: requiredUserProvider },
          select: { id: true },
        })
      : null;
    return { ...settings, checkerAvailable: environmentAvailable || Boolean(credential) };
  }
  const connections = await Promise.all(
    memberChoices.map((choice) =>
      choice.credentialId
        ? findModelCredentialById(deps.prisma, actor, choice.credentialId)
        : findModelCredential(deps.prisma, actor, choice.provider, choice.modelId),
    ),
  );
  const checkerAvailable =
    connections.some(Boolean) ||
    (deploymentChecker !== null && environmentAvailable) ||
    (
      await Promise.all(
        [...new Set(memberChoices.map((choice) => choice.provider))].map((provider) =>
          hasHostedModelCredits(deps.prisma, actor, provider),
        ),
      )
    ).some(Boolean);
  return { ...settings, checkerAvailable };
}

function requireBilling(deps: RouterDeps): BillingService {
  if (!deps.billing) throw new ORPCError("NOT_FOUND", { message: "Billing is not enabled" });
  return deps.billing;
}
