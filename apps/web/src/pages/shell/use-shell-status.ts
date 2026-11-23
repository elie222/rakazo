import type { AgentSkillCatalogEntry, SpaceMemoryConfig, VoiceStatus } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import type { SpaceQueries } from "../../lib/query/query";
import { queryClient } from "../../lib/query/query";

const NO_AGENT_SKILLS: AgentSkillCatalogEntry[] = [];
const NO_PROVIDERS: string[] = [];

/** What the space has set up that the shell offers around the chat: skills, messaging, memory and voice. */
export function useShellStatus(queries: SpaceQueries, signedIn: boolean) {
  const agentSkills = useQuery(queries.agentSkills.list.queryOptions()).data ?? NO_AGENT_SKILLS;
  const refreshAgentSkills = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queries.agentSkills.list.queryKey() });
  }, [queries]);
  const messagingStatus = useQuery({
    ...queries.messaging.status.queryOptions(),
    enabled: signedIn,
  }).data;
  const memoryConfigQuery = useQuery(queries.memory.providerConfig.queryOptions());
  // Undefined while it first loads; null when the space has none or it could not be read.
  const memoryProviderConfig: SpaceMemoryConfig | null | undefined =
    memoryConfigQuery.data !== undefined
      ? memoryConfigQuery.data
      : memoryConfigQuery.isError
        ? null
        : undefined;
  const voiceStatus: VoiceStatus | null =
    useQuery(queries.voice.status.queryOptions()).data ?? null;
  return {
    agentSkills,
    refreshAgentSkills,
    messagingEnabled: messagingStatus?.enabled ?? false,
    messagingProviders: messagingStatus?.providers ?? NO_PROVIDERS,
    memoryProviderConfig,
    voiceStatus,
  };
}
