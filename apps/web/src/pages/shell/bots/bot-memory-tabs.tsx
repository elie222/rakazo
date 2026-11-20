import { Trans, useLingui } from "@lingui/react/macro";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { MemoryDocumentList } from "../../space/KnowledgeSection";
import { SettingsCard, SwitchRow } from "./bot-settings-sections";

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
  const { t } = useLingui();
  return (
    <Tabs defaultValue="user">
      <TabsList className="mx-auto max-w-full overflow-x-auto">
        <TabsTrigger value="user" data-testid="bot-memory-tab-user">
          <Trans>About you</Trans>
        </TabsTrigger>
        <TabsTrigger value="bot" data-testid="bot-memory-tab-bot">
          <Trans>This bot</Trans>
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
    </Tabs>
  );
}
