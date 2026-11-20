import { useLingui } from "@lingui/react/macro";
import type { MemoryDream } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { Text, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { formatActivityRelativeTime } from "../../lib/inbox/activity";
import { useMobileTokens } from "../../lib/native/native";
import { rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { SettingsGroup, SettingsRow } from "../settings/settings-group";

const NO_DREAMS: MemoryDream[] = [];
const DREAM_PREVIEW_LIMIT = 5;
const DREAM_LINE_LIMIT = 2;

function statusLabel(
  t: (parts: TemplateStringsArray, ...values: unknown[]) => string,
  dream: MemoryDream,
): string {
  if (dream.undoneAt) return t`Undone`;
  if (dream.status === "completed") return t`Done`;
  if (dream.status === "queued") return t`Working`;
  return dream.errorKind === "spending" ? t`Stopped at the spending limit` : t`Interrupted`;
}

/** Why the dream ran, when a person would ask: a tidy, the daily review, or their own request. */
function reasonLabel(
  t: (parts: TemplateStringsArray, ...values: unknown[]) => string,
  dream: MemoryDream,
): string | null {
  if (dream.reason === "tidy") return t`Tidy`;
  if (dream.reason === "review") return t`Review`;
  if (dream.reason === "manual") return t`Manual`;
  return null;
}

/** The bot's consolidations, newest first; the whole list lives on the web. */
export function BotDreamsSection({ botId, memoryOff }: { botId: string; memoryOff: boolean }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const dreamsRead = rpcQuery("memory/dreams", { botId });
  const dreams = useScreenQuery(dreamsRead).data ?? NO_DREAMS;
  const dreamNow = useSave({
    save: (_: undefined, send) => send("memory/dreamNow", { botId }),
    stale: [dreamsRead.queryKey],
  });
  return (
    <SettingsGroup
      label={t`Dreams`}
      footer={
        memoryOff
          ? t`Memory is off, so dreams are paused.`
          : t`Between chats the bot tidies its memory from your own words.`
      }
    >
      {dreams.length === 0 ? (
        <SettingsRow title={t`No dreams yet`} detail={t`Dreaming uses one model call.`} />
      ) : (
        dreams.slice(0, DREAM_PREVIEW_LIMIT).map((dream) => (
          <View key={dream.id}>
            <SettingsRow
              title={formatActivityRelativeTime(dream.createdAt)}
              detail={dream.summary ?? undefined}
              value={statusLabel(t, dream)}
            />
            {reasonLabel(t, dream) ? (
              <Text
                style={{
                  color: tokens.mutedForeground,
                  ...typeScale.caption,
                  paddingHorizontal: 16,
                }}
              >
                {reasonLabel(t, dream)}
              </Text>
            ) : null}
            {dream.added.slice(0, DREAM_LINE_LIMIT).map((line) => (
              <Text
                key={`a-${line}`}
                numberOfLines={1}
                style={{ color: tokens.success, ...typeScale.caption, paddingHorizontal: 16 }}
              >
                + {line}
              </Text>
            ))}
            {dream.archived.slice(0, DREAM_LINE_LIMIT).map((line) => (
              <Text
                key={`r-${line}`}
                numberOfLines={1}
                style={{ color: tokens.destructive, ...typeScale.caption, paddingHorizontal: 16 }}
              >
                − {line}
              </Text>
            ))}
            {dream.added.length > DREAM_LINE_LIMIT || dream.archived.length > DREAM_LINE_LIMIT ? (
              <Text
                style={{
                  color: tokens.mutedForeground,
                  ...typeScale.caption,
                  paddingHorizontal: 16,
                }}
              >
                …
              </Text>
            ) : null}
          </View>
        ))
      )}
      {memoryOff ? null : (
        <SettingsRow
          title={t`Dream now`}
          detail={
            dreamNow.error
              ? errorText(dreamNow.error, t`Could not start a dream`)
              : dreamNow.pending
                ? t`Starting…`
                : t`Uses one model call.`
          }
          disabled={dreamNow.pending}
          onPress={() => dreamNow.run(undefined)}
        />
      )}
    </SettingsGroup>
  );
}
