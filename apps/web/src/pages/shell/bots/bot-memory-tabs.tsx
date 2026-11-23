import { Trans, useLingui } from "@lingui/react/macro";
import type { MemoryDream } from "@rakazo/contracts";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { MemoryDocumentList } from "../../space/KnowledgeSection";
import { SettingsCard, SwitchRow } from "./bot-settings-sections";

const NO_DREAMS: MemoryDream[] = [];

/**
 * The bot's memory page: what it knows about you (the Space's shared notes) and what it
 * keeps for itself. Each bank reaches its prompt only while its switch is on.
 */
export function BotMemoryTabs({
  botId,
  useOwnMemory,
  useSharedMemory,
  disabled,
  onSave,
}: {
  botId: string;
  useOwnMemory: boolean;
  useSharedMemory: boolean;
  disabled?: boolean;
  onSave: (patch: { useOwnMemory?: boolean; useSharedMemory?: boolean }) => void;
}) {
  return (
    <Tabs defaultValue="user">
      <TabsList className="mx-auto max-w-full overflow-x-auto">
        <TabsTrigger value="user" data-testid="bot-memory-tab-user">
          <Trans>About you</Trans>
        </TabsTrigger>
        <TabsTrigger value="bot" data-testid="bot-memory-tab-bot">
          <Trans>This bot</Trans>
        </TabsTrigger>
        <TabsTrigger value="dreams" data-testid="bot-memory-tab-dreams">
          <Trans>Dreams</Trans>
        </TabsTrigger>
      </TabsList>
      <TabsContent keepMounted value="user" className="space-y-4 pt-4">
        <SettingsCard>
          <SwitchRow
            id={`${botId}-shared-memory`}
            label={<Trans>Use shared notes</Trans>}
            checked={useSharedMemory}
            disabled={disabled}
            onChange={(checked) => onSave({ useSharedMemory: checked })}
          />
        </SettingsCard>
        <p className="text-body-sm text-muted-foreground">
          <Trans>
            Your name, timezone, important people and long-term preferences, shared by every bot in
            this space. Tell the bot to change them.
          </Trans>
        </p>
        <MemoryDocumentList input={{ scope: "user" }} testId="bot-shared-memory" />
      </TabsContent>
      <TabsContent keepMounted value="bot" className="space-y-4 pt-4">
        <SettingsCard>
          <SwitchRow
            id={`${botId}-own-memory`}
            label={<Trans>Use its own memory</Trans>}
            checked={useOwnMemory}
            disabled={disabled}
            onChange={(checked) => onSave({ useOwnMemory: checked })}
          />
        </SettingsCard>
        <p className="text-body-sm text-muted-foreground">
          <Trans>What this bot learned about you. Tell it in the chat to change a note.</Trans>
        </p>
        <MemoryDocumentList input={{ botId, scope: "bot" }} testId="bot-knowledge-memory" />
      </TabsContent>
      <TabsContent keepMounted value="dreams" className="space-y-4 pt-4">
        <DreamsList botId={botId} memoryOff={!useOwnMemory && !useSharedMemory} />
      </TabsContent>
    </Tabs>
  );
}

function dreamStatusLabel(
  t: (parts: TemplateStringsArray, ...values: unknown[]) => string,
  dream: MemoryDream,
): string {
  if (dream.undoneAt) return t`Undone`;
  if (dream.status === "completed") return t`Done`;
  if (dream.status === "queued") return t`Working`;
  return dream.errorKind === "spending" ? t`Stopped at the spending limit` : t`Interrupted`;
}

/** Why the dream ran, when a person would ask: a tidy, the daily review, or their own request. */
function dreamReasonLabel(
  t: (parts: TemplateStringsArray, ...values: unknown[]) => string,
  dream: MemoryDream,
): string | null {
  if (dream.reason === "tidy") return t`Tidy`;
  if (dream.reason === "review") return t`Review`;
  if (dream.reason === "manual") return t`Manual`;
  return null;
}

/** The nightly consolidations, newest first, with what each one changed. */
export function DreamsList({ botId, memoryOff }: { botId: string; memoryOff: boolean }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const dreams =
    useQuery(queries.memory.dreams.queryOptions({ input: { botId } })).data ?? NO_DREAMS;
  const dreamNow = useSave({
    save: (_: undefined, rpc) => rpc.memory.dreamNow({ botId }),
    stale: [queries.memory.dreams.queryKey({ input: { botId } })],
  });
  const undo = useSave({
    save: ({ dreamId }: { dreamId: string }, rpc) => rpc.memory.undoDream({ dreamId }),
    stale: [queries.memory.dreams.queryKey({ input: { botId } })],
  });
  // Only the newest finished dream can go back, and the server says so too.
  // An imported dream kept no run to undo, so it offers no Undo.
  const undoableId = dreams.find(
    (dream) => dream.status === "completed" && !dream.undoneAt && dream.runId,
  )?.id;
  if (memoryOff) {
    return (
      <p data-testid="bot-dreams-paused" className="text-body-sm text-muted-foreground">
        <Trans>Memory is off, so dreams are paused.</Trans>
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-body-sm text-muted-foreground">
          <Trans>Between conversations, the bot rewrites its notes from your own words.</Trans>{" "}
          <Trans>Dreaming now uses one model call.</Trans>
        </p>
        <Button
          variant="outline"
          size="sm"
          data-testid="bot-dream-now"
          disabled={dreamNow.pending}
          onClick={() => dreamNow.run(undefined)}
        >
          <Trans>Dream now</Trans>
        </Button>
      </div>
      {dreamNow.error ? (
        <p className="text-body-sm text-destructive">{errorText(dreamNow.error)}</p>
      ) : null}
      {undo.error ? <p className="text-body-sm text-destructive">{errorText(undo.error)}</p> : null}
      {dreams.length === 0 ? (
        <p data-testid="bot-dreams-empty" className="text-body">
          <Trans>No dreams yet.</Trans>
        </p>
      ) : (
        <ul data-testid="bot-dreams" className="space-y-2">
          {dreams.map((dream) => (
            <li key={dream.id} className="rounded-xl bg-muted/50 px-4 py-3">
              <div className="flex items-baseline justify-between gap-3 text-body">
                <span>{new Date(dream.createdAt).toLocaleString()}</span>
                <span className="flex items-baseline gap-2">
                  <span className="flex items-baseline gap-2 text-body-sm text-muted-foreground">
                    {dreamReasonLabel(t, dream) ? <span>{dreamReasonLabel(t, dream)}</span> : null}
                    <span>{dreamStatusLabel(t, dream)}</span>
                  </span>
                  {dream.id === undoableId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      disabled={undo.pending}
                      onClick={() => undo.run({ dreamId: dream.id })}
                    >
                      <Trans>Undo</Trans>
                    </Button>
                  ) : null}
                </span>
              </div>
              {dream.summary ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-body-sm text-muted-foreground">
                  {dream.summary}
                </p>
              ) : null}
              {dream.added.map((line) => (
                <p key={`a-${line}`} className="mt-1 break-words text-body-sm text-success">
                  + {line}
                </p>
              ))}
              {dream.archived.map((line) => (
                <p key={`r-${line}`} className="mt-1 break-words text-body-sm text-destructive">
                  − {line}
                </p>
              ))}
              {dream.added.length === 0 &&
              dream.archived.length === 0 &&
              dream.changedPaths.length > 0 ? (
                <p className="mt-1 break-words text-body-sm text-muted-foreground">
                  <Trans>Changed: {dream.changedPaths.join(", ")}</Trans>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
