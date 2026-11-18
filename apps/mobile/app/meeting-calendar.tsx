import { useLingui } from "@lingui/react/macro";
import type { RpcOutput } from "@rakazo/contracts";
import { MOBILE_MEETING_CALENDAR_CALLBACK_URL } from "@rakazo/contracts";
import { meetingPlatformLabel } from "@rakazo/i18n/meeting";
import { useIsFocused, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Alert, Platform, ScrollView } from "react-native";
import { SettingsFooter, SettingsGroup, SettingsRow } from "../components/settings/settings-group";
import { useSpaceChanges } from "../lib/api/roster-signals";
import { errorText } from "../lib/api/user-error";
import { useSideInsets } from "../lib/layout/side-insets";
import { showIOSActionSheet } from "../lib/native/ios-action-sheet";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

type Action =
  | { kind: "connect" | "disconnect" }
  | { kind: "once" | "series" | "skip" | "removeSeries"; eventId: string };
type UpcomingEvent = RpcOutput<"meetingCalendar/upcoming">["events"][number];

export default function MeetingCalendarScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { t, i18n } = useLingui();
  const read = rpcQuery("meetingCalendar/upcoming", { botId });
  const { data, error, refetch } = useScreenQuery(read, { enabled: Boolean(botId) });
  const focused = useIsFocused();
  useSpaceChanges("meetings", () => refetch({ cancelRefetch: false }), focused && Boolean(botId));
  const save = useSave({
    stale: [read.queryKey, rpcQuery("meetings/list", { botId }).queryKey],
    save: async (action: Action, send) => {
      switch (action.kind) {
        case "connect": {
          const started = await send("meetingCalendar/begin", { botId, client: "mobile" });
          const { openAuthSessionAsync } = await import("expo-web-browser");
          const result = await openAuthSessionAsync(
            started.authorizationUrl,
            MOBILE_MEETING_CALENDAR_CALLBACK_URL,
          );
          if (result.type !== "success") return;
          const { searchParams } = new URL(result.url);
          const state = searchParams.get("state");
          const code = searchParams.get("code");
          if (searchParams.get("error") === "access_denied") return;
          if (state !== started.state || !code)
            throw new Error(t`Calendar sign-in did not complete.`);
          return send("meetingCalendar/complete", { state, code });
        }
        case "disconnect":
          return send("meetingCalendar/disconnect", {});
        case "skip":
          return send("meetingCalendar/skip", { botId, eventId: action.eventId });
        case "removeSeries":
          return send("meetingCalendar/removeSeries", { botId, eventId: action.eventId });
        default:
          return send("meetingCalendar/select", {
            botId,
            eventId: action.eventId,
            scope: action.kind,
          });
      }
    },
    onFailed: (cause) => Alert.alert(t`Could not update calendar`, errorText(cause, t`Try again.`)),
  });
  useScreenHeader({ title: t`Auto-join` });
  const sideInsets = useSideInsets();
  const format = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium", timeStyle: "short" });

  function pick(event: UpcomingEvent, title: string) {
    const actions: Array<{ label: string; kind: "once" | "series" | "skip" | "removeSeries" }> = [
      { label: t`Join this meeting`, kind: "once" },
    ];
    if (event.recurring) actions.push({ label: t`Join this series`, kind: "series" });
    if (event.selection === "once" || event.selection === "series") {
      actions.push({ label: t`Skip this meeting`, kind: "skip" });
    }
    if (event.selection === "series")
      actions.push({ label: t`Stop joining this series`, kind: "removeSeries" });
    // iOS supports any number of choices in its native action sheet. On Android use
    // a native confirmation for removal to keep each alert within its button limit.
    const dispatch = (kind: (typeof actions)[number]["kind"]) =>
      save.run({ kind, eventId: event.id });
    if (Platform.OS === "ios") {
      showIOSActionSheet(
        {
          title,
          options: [...actions.map(({ label }) => label), t`Cancel`],
          cancelButtonIndex: actions.length,
        },
        (index) => {
          const action = actions[index];
          if (action) dispatch(action.kind);
        },
      );
    } else if (event.selection === "series") {
      Alert.alert(title, undefined, [
        { text: t`Cancel`, style: "cancel" },
        { text: t`Skip this meeting`, onPress: () => dispatch("skip") },
        { text: t`Stop joining this series`, onPress: () => dispatch("removeSeries") },
      ]);
    } else if (event.selection === "once") {
      Alert.alert(title, undefined, [
        { text: t`Cancel`, style: "cancel" },
        { text: t`Skip this meeting`, onPress: () => dispatch("skip") },
        ...(event.recurring
          ? [{ text: t`Join this series`, onPress: () => dispatch("series") }]
          : []),
      ]);
    } else {
      Alert.alert(title, undefined, [
        { text: t`Cancel`, style: "cancel" },
        ...actions.map(({ label, kind }) => ({ text: label, onPress: () => dispatch(kind) })),
      ]);
    }
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={sideInsets}>
      {error ? (
        <SettingsGroup label={t`Could not load calendar`}>
          <SettingsRow title={t`Try again`} onPress={() => void refetch()} />
        </SettingsGroup>
      ) : !data ? (
        <ActivityIndicator />
      ) : !data.available ? (
        <SettingsFooter>{t`Calendar scheduling is unavailable.`}</SettingsFooter>
      ) : !data.connected ? (
        <SettingsGroup
          footer={t`Connecting shares calendar access with the meeting service. You choose which meetings your bot joins.`}
        >
          <SettingsRow
            title={t`Connect ${data.calendarLabel}`}
            chevron="right"
            disabled={save.pending}
            onPress={() => save.run({ kind: "connect" })}
          />
        </SettingsGroup>
      ) : (
        <>
          <SettingsGroup label={t`Upcoming meetings`}>
            {data.events.length ? (
              data.events.map((event) => {
                const title = event.title || t`Untitled meeting`;
                const value =
                  event.selection === "another_bot"
                    ? t`Another bot`
                    : event.selection === "skipped"
                      ? t`Skipped`
                      : event.scheduled
                        ? t`Scheduled`
                        : event.selection === "none"
                          ? undefined
                          : t`Selected`;
                return (
                  <SettingsRow
                    key={event.id}
                    title={title}
                    detail={`${format.format(event.startsAt)} (${meetingPlatformLabel(event.platform)})`}
                    value={value}
                    chevron="right"
                    disabled={save.pending}
                    onPress={() => pick(event, title)}
                  />
                );
              })
            ) : (
              <SettingsRow title={t`No upcoming meetings`} />
            )}
          </SettingsGroup>
          <SettingsGroup>
            <SettingsRow
              title={t`Disconnect calendar`}
              disabled={save.pending}
              onPress={() =>
                Alert.alert(
                  t`Disconnect calendar?`,
                  t`Your bot will be removed from upcoming meetings on this calendar.`,
                  [
                    { text: t`Cancel`, style: "cancel" },
                    {
                      text: t`Disconnect`,
                      style: "destructive",
                      onPress: () => save.run({ kind: "disconnect" }),
                    },
                  ],
                )
              }
            />
          </SettingsGroup>
        </>
      )}
    </ScrollView>
  );
}
