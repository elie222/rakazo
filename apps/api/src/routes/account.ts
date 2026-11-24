import { ORPCError } from "@orpc/server";
import {
  changeUserTimezone,
  effectiveModelRole,
  hasHostedModelCredits,
  isAutoReviewCheckerConfigured,
  loadUserIncomingCalls,
  meetingCalendarScope,
  nativeCalendarScope,
  PushSessionEndedError,
  settleCallRequest,
  validateCreditOfferingChoice,
} from "@rakazo/adapters";
import type {
  ActionApprovalRule,
  Actor,
  Me,
  SettingsScope,
  SpaceChangeKind,
} from "@rakazo/contracts";
import { parseLabs } from "@rakazo/contracts";
import {
  abortableDelay,
  approvalModeFromPreference,
  approvalPreferenceFromMode,
  ClientError,
  callRequestClientNonce,
} from "@rakazo/core";
import { urlSite } from "@rakazo/core/egress";
import {
  accountPreferencesChangesScope,
  auditLogAccess,
  auditLogScope,
  commitBotUpdate,
  deploymentModelChangesScope,
  findAutoReviewPreference,
  findDefaultVoiceCredential,
  findModelCredential,
  findModelCredentialById,
  isRecordNotFound,
  listApprovalRules,
  listAuditEvents,
  listVoicePreferences,
  lockSpaceSettings,
  newestVoiceCredentialOrder,
  Prisma,
  pageChangesScope,
  removeApprovalRule,
  runAsSystem,
  runAsTenant,
  saveApprovalRule,
  saveAutoReviewPreference,
  selectVoicePreference,
  voicePreferenceTarget,
  withTransactionRetry,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { aiConsentStatus, allowAiConsent } from "../account/ai-consent.js";
import { createAccessGrant, listAccessGrants, revokeAccessGrant } from "../auth/access-grants.js";
import { requireAdmin } from "../auth/admins.js";
import type { BillingService } from "../billing/billing.js";
import {
  accountVoiceCatalog,
  disconnectVoiceCredential,
  effectiveVoiceStatus,
  loadDefaultVoiceCredential,
  loadVoiceCredential,
  persistVoiceCredential,
  prepareVoice,
  toVoiceCredential,
  toVoiceStatus,
  updateVoiceSpeechModel,
  voiceContext,
  voiceCredentialHasKey,
  voiceCredentialServer,
  voiceProviderFor,
  withVoiceConnection,
} from "../calls/voice.js";
import {
  recordCreditsChoice,
  recordSignInStep,
  startModelConnect,
} from "../models/model-connect-analytics.js";
import type { RouterDeps } from "../router.js";
import { dictationWords } from "../voice/dictation-words.js";
import type { RouterContext } from "./context.js";
import { HEARTBEAT, meDto, mergeStreams, withHeartbeats } from "./shared.js";

const ROSTER_CHANGED = Symbol("roster changed");
const ORGANIZATIONS_CHANGED = Symbol("organizations changed");

const SIGNAL_FAILURE_HOLD_MS = 30_000;

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
      modelSignInStep: authed.analytics.modelSignInStep.handler(async ({ context, input }) => {
        const signIn = await bestEffort(
          "model sign-in step",
          deps.oauthLogins.pendingSignIn(input.loginId, context.actor),
        );
        if (signIn) recordSignInStep(deps.analytics, signIn, input.step);
        return { ok: true as const };
      }),
    },
    health: os.health.handler(async () => ({ ok: true as const, version: "0.1.0" })),
    me: authed.me.handler(async ({ context }): Promise<Me> => meDto(deps, context.actor)),
    cloudComputers: {
      list: authed.cloudComputers.list.handler(
        async ({ context }) => (await deps.billing?.cloudComputers(context.actor)) ?? null,
      ),
      setSize: authed.cloudComputers.setSize.handler(async ({ context, input }) => {
        const billing = requireBilling(deps);
        await billing.setComputerSize(context.actor, input.computerId, input.size);
        return { ok: true as const };
      }),
    },
    billing: {
      selectFunding: authed.billing.selectFunding.handler(async ({ context, input }) => {
        const billing = requireBilling(deps);
        const started =
          input.funding === "credits"
            ? await startModelConnect(deps, context.actor, "credits", undefined, {
                surface: input.surface,
                appVersion: input.appVersion,
              })
            : undefined;
        const selected = await billing.selectFunding(
          context.actor,
          input.funding,
          input.client,
          input.interval,
          input.tier,
        );
        if (started) await recordCreditsChoice(deps, context.actor, started);
        return selected;
      }),
      purchaseCredits: authed.billing.purchaseCredits.handler(async ({ context, input }) =>
        requireBilling(deps).purchaseCredits(context.actor, input),
      ),
      setMonthlyCredits: authed.billing.setMonthlyCredits.handler(async ({ context, input }) =>
        requireBilling(deps).setMonthlyCredits(context.actor, input.amountCents),
      ),
      status: authed.billing.status.handler(async ({ context, input }) => {
        const billing = requireBilling(deps);
        // A failed claim fails the request, so the client keeps the code and sends it again.
        if (input?.referralCode) await billing.claimReferral(context.actor, input.referralCode);
        return billing.status(context.actor);
      }),
      computerUsage: authed.billing.computerUsage.handler(async ({ context }) =>
        requireBilling(deps).computerUsage(context.actor),
      ),
      refresh: authed.billing.refresh.handler(async ({ context }) => {
        const billing = requireBilling(deps);
        await billing.syncForActor(context.actor);
        return billing.status(context.actor);
      }),
      checkout: authed.billing.checkout.handler(async ({ context, input }) =>
        requireBilling(deps).checkout(context.actor, input?.client, input?.interval, input?.tier),
      ),
      portal: authed.billing.portal.handler(async ({ context, input }) =>
        requireBilling(deps).portal(context.actor, input?.client),
      ),
      endTrial: authed.billing.endTrial.handler(async ({ context }) => {
        const billing = requireBilling(deps);
        await billing.endTrial(context.actor);
        return billing.status(context.actor);
      }),
      switchToYearly: authed.billing.switchToYearly.handler(async ({ context }) => {
        const billing = requireBilling(deps);
        await billing.switchToYearly(context.actor);
        return billing.status(context.actor);
      }),
      changeTier: authed.billing.changeTier.handler(async ({ context, input }) => {
        const billing = requireBilling(deps);
        await billing.changeTier(context.actor, input.tier);
        return billing.status(context.actor);
      }),
      claimReferral: authed.billing.claimReferral.handler(async ({ context, input }) => {
        await requireBilling(deps).claimReferral(context.actor, input.code);
        return { ok: true as const };
      }),
    },
    accessGrants: {
      list: authed.accessGrants.list.handler(async ({ context }) => {
        await requireGrantAdmin(deps, context.actor);
        return listAccessGrants(deps.prisma);
      }),
      create: authed.accessGrants.create.handler(async ({ context, input }) => {
        await requireGrantAdmin(deps, context.actor);
        return createAccessGrant(deps.prisma, context.actor.userId, input);
      }),
      revoke: authed.accessGrants.revoke.handler(async ({ context, input }) => {
        await requireGrantAdmin(deps, context.actor);
        return revokeAccessGrant(deps.prisma, input.id);
      }),
    },
    preferences: {
      update: authed.preferences.update.handler(async ({ context, input }): Promise<Me> => {
        const userId = context.actor.userId;
        const botAvatarSet = input.botAvatarSet;
        // A feature the deployment turns on is not the account's choice, so it is not saved with it.
        const deploymentLabs = deps.env?.deploymentLabs ?? [];
        const labs =
          input.labs === undefined
            ? undefined
            : parseLabs(input.labs).filter((feature) => !deploymentLabs.includes(feature));
        const data = {
          ...(input.locale === undefined ? {} : { locale: input.locale }),
          ...(botAvatarSet === undefined ? {} : { botAvatarSet }),
          ...(labs === undefined ? {} : { labs }),
          ...input.chatPreferences,
        };
        if (input.timezone !== undefined) {
          // The routines that took the account zone keep their local schedule in the new
          // one, and the other fields commit in the same save. The move's row lock still
          // waits for any bot creation holding the user row, so no new bot is missed below.
          await changeUserTimezone(deps, userId, input.timezone, data);
        } else {
          await deps.prisma.user.update({
            where: { id: userId },
            // An avatar style from an older app is accepted and ignored: there is only one.
            data,
          });
        }
        if (input.chatPreferences !== undefined)
          await deps.events.publishSpaceChange?.(
            accountPreferencesChangesScope(userId),
            "preferences",
          );
        if (botAvatarSet !== undefined) {
          // Every bot of this user not pinned to another set follows the new default, in every
          // space they own bots in, announced like any edit so other devices redraw it.
          const bots = await runAsSystem("restyle the user's own bots in all their spaces", () =>
            deps.prisma.bot.findMany({
              where: { userId, avatarSetPinned: false, avatarSet: { not: botAvatarSet } },
              select: { id: true, spaceId: true, thread: { select: { id: true } } },
            }),
          );
          for (const bot of bots) {
            const threadId = bot.thread?.id;
            if (!threadId) continue;
            // A newer save changed the default again: its own pass owns the remaining bots.
            const current = await deps.prisma.user.findUniqueOrThrow({
              where: { id: userId },
              select: { botAvatarSet: true },
            });
            if (current.botAvatarSet !== botAvatarSet) break;
            // The default is saved; a bot that fails here keeps its style until the next save.
            await runAsTenant({ spaceId: bot.spaceId, userId }, () =>
              commitBotUpdate({
                prisma: deps.prisma,
                notify: (thread, seq) => deps.events.notify(thread, seq),
                spaceId: bot.spaceId,
                threadId,
                botId: bot.id,
                emitBotUpdated: true,
                // Pinned since it was listed: leave the owner's choice alone.
                expectedSettings: { avatarSetPinned: false },
                // Re-read under lock inside the transaction: a newer save of the
                // default that lands while this writes owns the bot instead.
                expectedUserAvatarSet: { userId, botAvatarSet },
                data: { avatarSet: botAvatarSet },
              }),
            ).catch((error) => {
              if (!isRecordNotFound(error)) getLogger().error("bot style restyle", error);
            });
          }
        }
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
        const access = await auditLogAccess(deps.prisma, context.actor);
        if (!access) throw new ORPCError("FORBIDDEN");
        return runAsSystem("read the organization's audit log", () =>
          listAuditEvents(deps.prisma, access.organizationId, auditLogScope(access, input)),
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
      subscribe: authed.notifications.subscribe.handler(async function* ({ context }) {
        const {
          followChatAlerts,
          followOrganizationChanges,
          followRosterChanges,
          followSpaceChanges,
        } = deps.events;
        if (!followChatAlerts) throw new ORPCError("NOT_FOUND");
        const { spaceId, userId } = context.actor;
        const rosterChanges = async function* (
          signal: AbortSignal,
        ): AsyncGenerator<typeof ROSTER_CHANGED> {
          if (!followRosterChanges) return;
          // The app re-reads the roster only on these signals, so a failure ends the stream the
          // same way Space changes do below.
          try {
            for await (const _ of followRosterChanges(userId, signal)) yield ROSTER_CHANGED;
          } catch (error) {
            await abortableDelay(SIGNAL_FAILURE_HOLD_MS, signal);
            throw error;
          }
        };
        const spaceChanges = async function* (
          signal: AbortSignal,
          special?:
            | "meetingCalendar"
            | "nativeCalendar"
            | "pages"
            | "deploymentModel"
            | "preferences",
        ): AsyncGenerator<{ spaceChange: SpaceChangeKind }> {
          if (!followSpaceChanges) return;
          let scope = spaceId;
          if (special === "meetingCalendar") {
            if (!deps.meetingCalendar) return;
            scope = meetingCalendarScope(spaceId, userId);
          } else if (special === "nativeCalendar") {
            if (!context.nativeSessionId) return;
            scope = nativeCalendarScope({ spaceId, userId, sessionId: context.nativeSessionId });
          } else if (special === "pages") {
            scope = pageChangesScope(userId);
          } else if (special === "deploymentModel") {
            scope = deploymentModelChangesScope;
          } else if (special === "preferences") {
            scope = accountPreferencesChangesScope(userId);
          }
          // The app re-reads what these cover only on signals, so a failure ends the stream and
          // the app reconnects and re-reads. Alerts keep flowing for a while first, so a lasting
          // failure costs one reconnect every half minute rather than a tight loop.
          try {
            for await (const spaceChange of followSpaceChanges(scope, signal)) {
              if (
                special
                  ? spaceChange === special
                  : spaceChange !== "meetingCalendar" &&
                    spaceChange !== "nativeCalendar" &&
                    spaceChange !== "pages" &&
                    spaceChange !== "deploymentModel" &&
                    spaceChange !== "preferences"
              )
                yield { spaceChange };
            }
          } catch (error) {
            await abortableDelay(SIGNAL_FAILURE_HOLD_MS, signal);
            throw error;
          }
        };
        const organizationChanges = async function* (
          signal: AbortSignal,
        ): AsyncGenerator<typeof ORGANIZATIONS_CHANGED> {
          if (!followOrganizationChanges) return;
          try {
            for await (const _ of followOrganizationChanges(userId, signal))
              yield ORGANIZATIONS_CHANGED;
          } catch (error) {
            await abortableDelay(SIGNAL_FAILURE_HOLD_MS, signal);
            throw error;
          }
        };
        const frames = withHeartbeats(context, (signal) =>
          mergeStreams(
            followChatAlerts(userId, spaceId, signal),
            rosterChanges(signal),
            spaceChanges(signal),
            spaceChanges(signal, "meetingCalendar"),
            spaceChanges(signal, "nativeCalendar"),
            spaceChanges(signal, "pages"),
            spaceChanges(signal, "deploymentModel"),
            spaceChanges(signal, "preferences"),
            organizationChanges(signal),
          ),
        );
        for await (const next of frames) {
          if (next === HEARTBEAT) yield { type: "heartbeat" as const };
          else if (next === ROSTER_CHANGED) yield { type: "roster" as const };
          else if (next === ORGANIZATIONS_CHANGED) yield { type: "organizations" as const };
          else if ("spaceChange" in next) yield { type: next.spaceChange };
          else if (next.spaceId === spaceId) yield { type: "alert" as const, alert: next };
        }
      }),
      subscribeCalls: authed.notifications.subscribeCalls.handler(async function* ({ context }) {
        const { followIncomingCalls } = deps.events;
        if (!deps.env?.phoneCallsEnabled || !followIncomingCalls) throw new ORPCError("NOT_FOUND");
        const { userId } = context.actor;
        const signals = withHeartbeats(context, (signal) => followIncomingCalls(userId, signal));
        for await (const next of signals) {
          yield next === HEARTBEAT
            ? { type: "heartbeat" as const }
            : {
                type: "incoming.calls" as const,
                payload: { calls: await loadUserIncomingCalls(deps.prisma, userId) },
              };
        }
      }),
      declineIncomingCall: authed.notifications.declineIncomingCall.handler(
        async ({ context, input }) => {
          if (!deps.env?.phoneCallsEnabled) throw new ORPCError("NOT_FOUND");
          // A locked device has only the call id, and may be viewing a different Space.
          const settled = await runAsSystem(
            "decline the signed-in call owner's incoming call",
            async () => {
              const message = await deps.prisma.message.findFirst({
                where: {
                  clientNonce: callRequestClientNonce(input.callId),
                  role: "bot",
                  thread: {
                    userId: context.actor.userId,
                    groupId: null,
                    bot: { userId: context.actor.userId },
                  },
                },
                select: { threadId: true },
              });
              if (!message) throw new ORPCError("NOT_FOUND");
              return settleCallRequest(deps, {
                threadId: message.threadId,
                callId: input.callId,
                from: ["ringing"],
                status: "declined",
              });
            },
          );
          if (settled?.status !== "declined") throw new ORPCError("CONFLICT");
          return { ok: true as const };
        },
      ),
      registerCallPush: authed.notifications.registerCallPush.handler(
        async ({ context, input }) => {
          if (!context.sessionId) throw new ORPCError("UNAUTHORIZED");
          try {
            await deps.pushTokens.saveDevice?.(context.actor.userId, input, context.sessionId);
          } catch (error) {
            if (error instanceof PushSessionEndedError)
              throw new ClientError("UNAUTHORIZED", "Unauthorized");
            throw error;
          }
          return { ok: true as const };
        },
      ),
      registerPush: authed.notifications.registerPush.handler(async ({ context, input }) => {
        const sessionId = context.sessionId;
        if (!sessionId) throw new ORPCError("UNAUTHORIZED");
        try {
          await deps.pushTokens.save(
            context.actor.userId,
            input.token,
            sessionId,
            input.presentation,
          );
        } catch (error) {
          if (error instanceof PushSessionEndedError)
            throw new ClientError("UNAUTHORIZED", "Unauthorized");
          throw error;
        }
        return { ok: true as const };
      }),
      unregisterPush: authed.notifications.unregisterPush.handler(async ({ context }) => {
        if (context.sessionId) {
          // Only the calling session's registration: another device of this account,
          // which registered from its own session, keeps its notifications.
          await deps.pushTokens.endSession(context.actor.userId, context.sessionId);
          return { ok: true as const };
        }
        await deps.pushTokens.remove(context.actor.userId);
        return { ok: true as const };
      }),
      followWorkActivity: authed.notifications.followWorkActivity.handler(
        async ({ context, input }) => {
          // The card ends with the session that registered it.
          if (!context.sessionId) throw new ORPCError("UNAUTHORIZED");
          if (!input.token) return { following: Boolean(deps.workActivities) };
          const following = await deps.workActivities?.register(
            context.actor.userId,
            context.sessionId,
            input.token,
          );
          return { following: following ?? false };
        },
      ),
      registerWorkActivityStarts: authed.notifications.registerWorkActivityStarts.handler(
        async ({ context, input }) => {
          // The phone stops getting cards with the session that registered it.
          if (!context.sessionId) throw new ORPCError("UNAUTHORIZED");
          await deps.workActivities?.registerStarts(
            context.actor.userId,
            context.sessionId,
            input.token,
          );
          return { ok: true as const };
        },
      ),
    },
    voice: {
      catalog: authed.voice.catalog.handler(async ({ context }) =>
        accountVoiceCatalog(deps, context.actor),
      ),
      status: authed.voice.status.handler(async ({ context, input }) => {
        return effectiveVoiceStatus(deps, context.actor, input?.scope);
      }),
      words: authed.voice.words.handler(async ({ context }) => ({
        words: await dictationWords(deps.prisma, context.actor),
      })),
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
              hasKey: await voiceCredentialHasKey(deps, context.actor, row),
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
          sttBaseUrl: input.sttBaseUrl,
          sttApiKey: input.sttApiKey,
          ttsModel: input.ttsModel,
          sttModel: input.sttModel,
          transcriptionVocabulary: input.transcriptionVocabulary,
          scope: input.scope,
          signal: context.signal,
        }),
      ),
      disconnect: authed.voice.disconnect.handler(async ({ context, input }) =>
        disconnectVoiceCredential(deps, context.actor, { provider: input.provider }),
      ),
      setVoice: authed.voice.setVoice.handler(async ({ context, input }) => {
        const cred = await withTransactionRetry(() =>
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
        updateVoiceSpeechModel(deps, context.actor, { ...input, signal: context.signal }),
      ),
      voices: authed.voice.voices.handler(async ({ context, input }) => {
        // A named provider lists its voices even before the copy has a default voice.
        const row = input.provider
          ? await loadVoiceCredential(
              deps,
              context.actor,
              input.provider,
              input.scope,
              context.signal,
            )
          : await loadDefaultVoiceCredential(deps, context.actor, input.scope, context.signal);
        if (!row) return [];
        const provider = await voiceProviderFor(deps, row.cred.provider);
        return withVoiceConnection(row.cred.provider, row.linked, () =>
          provider.listVoices(row.apiKey, voiceContext(context.actor, context.signal), {
            language: input.language,
            model: row.cred.speechModel || undefined,
          }),
        );
      }),
      models: authed.voice.models.handler(async ({ context, input }) => {
        const row = await loadVoiceCredential(
          deps,
          context.actor,
          input.provider,
          input.scope,
          context.signal,
        );
        if (!row) return [];
        const provider = await voiceProviderFor(deps, row.cred.provider);
        if (!provider.listModels) return [];
        return withVoiceConnection(row.cred.provider, row.linked, () =>
          provider.listModels!(row.apiKey, voiceContext(context.actor, context.signal)),
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
      { env: process.env, includedApproval: deps.billing?.modelCreditsEnabled === true },
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
  const environmentAvailable = isAutoReviewCheckerConfigured({
    env: process.env,
    checker: deploymentChecker
      ? { provider: deploymentChecker.provider, model: deploymentChecker.modelId }
      : undefined,
  });
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
    (
      await Promise.all(
        memberChoices.map((choice) =>
          choice.creditOfferingId
            ? validateCreditOfferingChoice(
                deps.prisma,
                deps.secrets,
                actor,
                choice.provider,
                choice.modelId,
                choice.creditOfferingId,
              )
            : false,
        ),
      )
    ).some(Boolean) ||
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

async function requireGrantAdmin(deps: RouterDeps, actor: Actor) {
  await requireAdmin(deps, actor.userId);
  if (!deps.billing?.modelCreditsEnabled)
    throw new ORPCError("NOT_FOUND", { message: "Model credits are not enabled" });
}
