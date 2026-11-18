import { useLingui } from "@lingui/react/macro";
import { canLeaveMeeting } from "@rakazo/contracts";
import { showCalendarStatusRetry } from "@rakazo/core";
import { meetingPlatformLabel, meetingStatusLabel, meetingTime } from "@rakazo/i18n/meeting";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text } from "react-native";
import { NativeActionButton } from "../components/native/native-action-button";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsRow,
} from "../components/settings/settings-group";
import { useSpaceChanges } from "../lib/api/roster-signals";
import { errorText } from "../lib/api/user-error";
import { mobileTokens } from "../lib/appearance/appearance";
import { useSideInsets } from "../lib/layout/side-insets";
import { native, useThemedStyles } from "../lib/native/native";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

export default function MeetingsScreen() {
  const { t } = useLingui();
  const router = useRouter();
  const { botId = "" } = useLocalSearchParams<{ botId?: string }>();
  const [url, setUrl] = useState("");
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const read = rpcQuery("meetings/list", { botId });
  const list = useScreenQuery(read, { enabled: Boolean(botId) });
  const calendar = useScreenQuery(rpcQuery("meetingCalendar/status", { botId }), {
    enabled: Boolean(botId && list.data?.enabled),
  });
  const calendarStatusRetry = list.data?.enabled && showCalendarStatusRetry(calendar);
  const focused = useIsFocused();
  useSpaceChanges(
    "meetings",
    () => list.refetch({ cancelRefetch: false }),
    focused && Boolean(botId),
  );

  const join = useSave({
    save: (url: string, send) => send("meetings/join", { botId, url, shareTranscript: true }),
    stale: [read.queryKey],
    onSaved: () => setUrl(""),
  });
  const leave = useSave({
    save: (id: string, send) => send("meetings/leave", { id }),
    stale: [read.queryKey],
  });
  const busy = join.pending || leave.pending;
  const error = join.error ?? leave.error ?? list.error;
  useScreenHeader({ title: t`Meetings` });

  return (
    <ScrollView
      style={[styles.screen, sideInsets]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      {list.data?.enabled ? (
        <>
          <SettingsGroup
            label={t`Meeting link`}
            footer={t`Get permission to record and share the transcript with this Space.`}
          >
            <SettingsInputRow
              accessibilityLabel={t`Meeting link`}
              keyboardType="url"
              autoCorrect={false}
              autoCapitalize="none"
              editable={!busy}
              value={url}
              onChangeText={(value) => {
                join.reset();
                setUrl(value);
              }}
            />
          </SettingsGroup>
          <NativeActionButton
            label={t`Join meeting`}
            busy={join.pending}
            disabled={busy || !url.trim()}
            onPress={() => join.run(url.trim())}
          />
        </>
      ) : list.isFetching ? (
        <ActivityIndicator accessibilityLabel={t`Loading meetings…`} />
      ) : list.data || !botId ? (
        <Text style={styles.note}>{t`Meeting joins are unavailable.`}</Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorText(error, t`Could not update meetings`)}
        </Text>
      ) : null}
      {!list.error && list.data?.meetings.length ? (
        <SettingsGroup accessibilityLabel={t`Recent meetings`}>
          {list.data.meetings.map((meeting) => {
            const canRead = meeting.transcriptAvailable;
            const canLeave = canLeaveMeeting(meeting.status);
            const status = meeting.error ?? meetingStatusLabel(meeting.status);
            return (
              <SettingsRow
                key={meeting.id}
                title={meetingPlatformLabel(meeting.platform)}
                detail={canRead ? meetingTime(meeting.createdAt) : status}
                value={canRead || canLeave ? undefined : meetingTime(meeting.createdAt)}
                chevron={canRead ? "right" : undefined}
                accessibilityRole={canRead ? "button" : undefined}
                accessibilityHint={canRead ? t`View transcript` : undefined}
                onPress={
                  canRead
                    ? () =>
                        router.push({
                          pathname: "/meeting-transcript",
                          params: { id: meeting.id, botId },
                        })
                    : undefined
                }
                trailing={
                  canLeave ? (
                    <NativeActionButton
                      label={t`Leave meeting`}
                      prominence="secondary"
                      size="compact"
                      disabled={busy}
                      onPress={() => leave.run(meeting.id)}
                    />
                  ) : undefined
                }
              />
            );
          })}
        </SettingsGroup>
      ) : null}
      {list.data?.enabled && calendar.data?.available ? (
        <SettingsGroup>
          <SettingsRow
            title={t`Auto-join`}
            chevron="right"
            onPress={() => router.push({ pathname: "/meeting-calendar", params: { botId } })}
          />
        </SettingsGroup>
      ) : calendarStatusRetry ? (
        <SettingsGroup label={t`Auto-join`}>
          <SettingsRow
            title={t`Could not load calendar`}
            value={t`Try again`}
            disabled={calendar.isFetching}
            onPress={() => void calendar.refetch()}
          />
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 16, gap: 16 },
    note: { color: native.secondaryLabel },
    error: { color: mobileTokens().destructive },
  });
}
