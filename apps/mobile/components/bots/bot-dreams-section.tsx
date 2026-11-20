import { useLingui } from "@lingui/react/macro";
import type { MemoryDream } from "@rakazo/contracts";
import { rpcQuery } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { SettingsGroup, SettingsRow } from "../settings/settings-group";

const NO_DREAMS: MemoryDream[] = [];
const DREAM_PREVIEW_LIMIT = 5;

function statusLabel(
  t: (parts: TemplateStringsArray, ...values: unknown[]) => string,
  dream: MemoryDream,
): string {
  if (dream.status === "completed") return t`Done`;
  if (dream.status === "queued") return t`Working`;
  return dream.errorKind === "spending" ? t`Stopped at the spending limit` : t`Interrupted`;
}

/** The bot's nightly consolidations, newest first; the whole list lives on the web. */
export function BotDreamsSection({ botId, memoryOff }: { botId: string; memoryOff: boolean }) {
  const { t } = useLingui();
  const dreams = useScreenQuery(rpcQuery("memory/dreams", { botId })).data ?? NO_DREAMS;
  return (
    <SettingsGroup
      label={t`Dreams`}
      footer={memoryOff ? t`Memory is off, so dreams are paused.` : undefined}
    >
      {dreams.length === 0 ? (
        <SettingsRow
          title={t`No dreams yet`}
          detail={t`Between conversations, the bot rewrites its notes from your own words.`}
        />
      ) : (
        dreams
          .slice(0, DREAM_PREVIEW_LIMIT)
          .map((dream) => (
            <SettingsRow
              key={dream.id}
              title={new Date(dream.createdAt).toLocaleString()}
              detail={dream.summary ?? undefined}
              value={statusLabel(t, dream)}
            />
          ))
      )}
    </SettingsGroup>
  );
}
