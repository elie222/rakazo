export type BotMemoryEvidence = {
  ownerUserId: string;
  spaceId: string;
  botId: string;
  scope: "private" | "shared";
  sharedScopeId?: string;
  sourceGeneration?: number;
  suppressed: boolean;
};

export type BotMemoryReader = {
  ownerUserId: string;
  spaceId: string;
  botId: string;
  currentGeneration: number;
  sharedScopeIds: readonly string[];
};

/** Apply both before external retrieval and to returned records; provider filters are not authority. */
export function canRecallBotMemory(reader: BotMemoryReader, evidence: BotMemoryEvidence): boolean {
  if (evidence.suppressed || evidence.spaceId !== reader.spaceId) return false;
  if (
    evidence.sourceGeneration !== undefined &&
    (evidence.botId !== reader.botId || evidence.sourceGeneration !== reader.currentGeneration)
  ) {
    return false;
  }
  if (evidence.scope === "private") {
    return evidence.ownerUserId === reader.ownerUserId && evidence.botId === reader.botId;
  }
  return !!evidence.sharedScopeId && reader.sharedScopeIds.includes(evidence.sharedScopeId);
}

export type ProviderDeletionStatus = "pending" | "completed" | "failed";

/** Local suppression takes effect even while remote erasure is unconfirmed. */
export function forgottenMemoryStatus(providerStatus: ProviderDeletionStatus) {
  return {
    suppressed: true as const,
    remoteDeletion: providerStatus,
    erasureConfirmed: providerStatus === "completed",
  };
}
