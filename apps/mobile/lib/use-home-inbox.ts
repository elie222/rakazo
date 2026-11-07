import { isRetryableError, reportUiLocale } from "@rakazo/core";
import { useRouter } from "expo-router";
import type { RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import type { MobileBot, MobileBotSection, MobileGroup, MobileMe, MobileSpace } from "./api";
import { currentApiBase, rpc, selectedSpaceId, selectInitialSpace } from "./api";
import { appBadgeGeneration } from "./app-badge";
import { isPaywallShown } from "./billing";
import { reportDeviceTimeZone } from "./device-timezone";
import { getActiveUiLocale, useI18n } from "./i18n";
import { retainInboxValue } from "./inbox-retention";
import { ensureOrganizations } from "./organizations";
import { forgetReferrals, rememberReferral } from "./referral";
import { saveInbox } from "./saved-chats";
import { currentSessionGeneration } from "./session";
import type { LoadFailureKind } from "./user-error";
import { errorText, loadFailureKind } from "./user-error";

/** The account this launch has saved its language to (see the inbox load). */
let localeReportedFor: string | null = null;

/** The inbox's chats, Spaces, and account, and the load that fetches them. */
export function useHomeInbox(
  spaceActionRef: RefObject<{ busy: boolean; recoveryId: string | null }>,
) {
  const { t } = useI18n();
  const router = useRouter();
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [groups, setGroups] = useState<MobileGroup[]>([]);
  const [botSections, setBotSections] = useState<MobileBotSection[]>([]);
  const [spaces, setSpaces] = useState<MobileSpace[]>([]);
  const [me, setMe] = useState<Pick<MobileMe, "userId" | "spaceId" | "name"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from action errors so a failed action never borrows the load's title.
  const [inboxLoading, setInboxLoading] = useState(false);
  const [loadFailure, setLoadFailure] = useState<{ kind: LoadFailureKind; message: string } | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [badgeLoad, setBadgeLoad] = useState<{ generation: number } | null>(null);
  const inboxRequestId = useRef(0);
  const inboxLoaded = useRef(false);

  const loadBots = useCallback(async () => {
    const badgeGeneration = appBadgeGeneration();
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    const requestId = ++inboxRequestId.current;
    const apiBase = currentApiBase();
    const generation = currentSessionGeneration();
    setError(null);
    setInboxLoading(true);
    try {
      const [navigation, nextMe] = await Promise.all([rpc("spaces/list"), rpc("me")]);
      if (
        requestId !== inboxRequestId.current ||
        generation !== currentSessionGeneration() ||
        apiBase !== currentApiBase()
      )
        return;
      if (!(await selectInitialSpace(nextMe.spaceId))) {
        throw new Error(t("Could not save the default space"));
      }
      if (
        requestId !== inboxRequestId.current ||
        generation !== currentSessionGeneration() ||
        apiBase !== currentApiBase()
      )
        return;
      if (!nextMe.billingEnabled) forgetReferrals();
      else {
        // Filed under the Space it was fetched for, so a late answer never shows in another.
        const spaceId = selectedSpaceId();
        void rpc("billing/status")
          .then((billing) => {
            const current =
              requestId === inboxRequestId.current &&
              generation === currentSessionGeneration() &&
              apiBase === currentApiBase();
            // Only while this session is still the live one: a reply after sign-out must not
            // restore the previous owner's link.
            if (current) rememberReferral(spaceId, billing.referral);
            if (current && billing.funding !== undefined && !billing.access && !isPaywallShown())
              router.push("/paywall");
          })
          .catch(() => undefined);
      }
      setBots((current) => retainInboxValue(current, navigation.current.bots));
      setBotSections((current) => retainInboxValue(current, navigation.current.botSections));
      setGroups((current) => retainInboxValue(current, navigation.current.groups));
      setSpaces((current) => retainInboxValue(current, navigation.spaces));
      setMe((current) => retainInboxValue(current, nextMe));
      // Emails follow the app's language, so the account keeps the one this app runs in. Once
      // per account and launch: polls must not undo a language picked on another device since.
      // A server that predates it leaves `locale` out.
      if (localeReportedFor !== nextMe.userId && nextMe.locale !== undefined) {
        localeReportedFor = nextMe.userId;
        if (nextMe.locale !== getActiveUiLocale()) {
          void reportUiLocale(getActiveUiLocale, (locale) =>
            rpc("preferences/update", { locale }),
          ).catch(() => undefined);
        }
      }
      // The account follows this device's zone until the user picks one by hand; the
      // me this poll brought says what the server holds and who chose it, so a report
      // goes out only on a difference, also covering the foreground return after a
      // zone change.
      void reportDeviceTimeZone(nextMe.userId, nextMe.timezone, nextMe.timezoneSource).catch(
        () => undefined,
      );
      inboxLoaded.current = true;
      void ensureOrganizations();
      setBadgeLoad({ generation: badgeGeneration });
      setLoadFailure(null);
      saveInbox(
        {
          apiBase,
          userId: nextMe.userId,
          spaceId: navigation.current.id,
          sessionGeneration: generation,
          selectionId: selectedSpaceId(),
        },
        navigation,
        nextMe,
      );
      return true;
    } catch (err) {
      if (
        requestId !== inboxRequestId.current ||
        generation !== currentSessionGeneration() ||
        apiBase !== currentApiBase()
      )
        return;
      setLoadFailure({
        kind: loadFailureKind(err),
        message: errorText(err, t("Could not load bots")),
      });
      // False when the server refused rather than failed: asking again only polls it.
      return isRetryableError(err);
    } finally {
      if (requestId === inboxRequestId.current) setInboxLoading(false);
    }
  }, []);

  const refreshBots = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadBots();
    } finally {
      setRefreshing(false);
    }
  }, [loadBots]);

  return {
    bots,
    setBots,
    groups,
    setGroups,
    botSections,
    setBotSections,
    spaces,
    setSpaces,
    me,
    setMe,
    error,
    setError,
    inboxLoading,
    loadFailure,
    refreshing,
    badgeLoad,
    inboxRequestId,
    inboxLoaded,
    loadBots,
    refreshBots,
  };
}
