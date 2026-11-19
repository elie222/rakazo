import { useLingui } from "@lingui/react/macro";
import type { RpcOutput } from "@rakazo/contracts";
import {
  MeetingCalendarOAuthErrorSchema,
  MOBILE_MEETING_CALENDAR_CALLBACK_URL,
} from "@rakazo/contracts";
import type { MeetingCalendarAction } from "@rakazo/i18n/meeting";
import {
  meetingCalendarActionLabel,
  meetingCalendarActions,
  meetingCalendarSharingNotice,
  meetingCalendarStatusLabel,
  meetingPlatformLabel,
} from "@rakazo/i18n/meeting";
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

type Action = { kind: "connect" | "disconnect" } | { kind: MeetingCalendarAction; eventId: string };
type UpcomingEvent = RpcOutput<"meetingCalendar/upcoming">["events"][number];

export default function MeetingCalendarScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { t, i18n } = useLingui();
  const read = rpcQuery("meetingCalendar/upcoming", { botId });
  const { data, error, refetch } = useScreenQuery(read, { enabled: Boolean(botId) });
  const focused = useIsFocused();
  useSpaceChanges(
    "meetingCalendar",
    () => refetch({ cancelRefetch: false }),
    focused && Boolean(botId),
  );
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
          if (
            state !== started.state ||
            ["state", "code", "error"].some((key) => searchParams.getAll(key).length > 1)
          )
            throw new Error(t`Calendar sign-in did not complete.`);
          if (searchParams.has("error")) {
            const error = MeetingCalendarOAuthErrorSchema.safeParse(searchParams.get("error"));
            if (error.data === "denied") return;
            if (error.data === "unavailable") {
              throw new Error(t`Calendar sign-in is temporarily unavailable.`);
            }
            throw new Error(t`Calendar sign-in did not complete.`);
          }
          if (!code) throw new Error(t`Calendar sign-in did not complete.`);
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
            shareTranscript: true,
          });
      }
    },
    onFailed: (cause) => Alert.alert(t`Could not update calendar`, errorText(cause, t`Try again.`)),
  });
  useScreenHeader({ title: t`Auto-join` });
  const sideInsets = useSideInsets();
  const format = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium", timeStyle: "short" });

  function pick(event: UpcomingEvent, title: string) {
    const availableActions = meetingCalendarActions(event);
    const message = meetingCalendarSharingNotice(availableActions);
    const actions = availableActions.map((kind) => ({
      kind,
      label: meetingCalendarActionLabel(kind),
    }));
    const dispatch = (kind: MeetingCalendarAction) => save.run({ kind, eventId: event.id });
    if (Platform.OS === "ios") {
      showIOSActionSheet(
        {
          title,
          message,
          options: [...actions.map(({ label }) => label), t`Cancel`],
          cancelButtonIndex: actions.length,
        },
        (index) => {
          const action = actions[index];
          if (action) dispatch(action.kind);
        },
      );
    } else {
      Alert.alert(title, message, [
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
      ) : data.disconnecting || data.connecting ? (
        <SettingsGroup
          label={data.disconnecting ? t`Disconnecting calendar…` : t`Connecting calendar…`}
        >
          <SettingsRow
            title={data.disconnecting ? t`Try again` : t`Disconnect calendar`}
            disabled={save.pending}
            onPress={() => save.run({ kind: "disconnect" })}
          />
        </SettingsGroup>
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
                const value = meetingCalendarStatusLabel(event);
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
