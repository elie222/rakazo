import type { ChatPreferences } from "@rakazo/contracts";
import { composerModelPickerPreference } from "../models/composer-model-picker-preference";
import type { SpaceQueries } from "../query/query";
import { responseStreamingPreference } from "./response-streaming";

export const deviceChatPreferences = {
  composerModelPicker: composerModelPickerPreference,
  streamReplies: responseStreamingPreference,
};

export function chatPreferencesQuery(queries: SpaceQueries, userId?: string | null) {
  return {
    ...queries.me.queryOptions(),
    enabled: Boolean(userId),
    refetchOnWindowFocus: "always" as const,
  };
}

export function useChatPreferences(saved: ChatPreferences | undefined) {
  const composerModelPicker = deviceChatPreferences.composerModelPicker.use();
  const streamReplies = deviceChatPreferences.streamReplies.use();
  return {
    composerModelPicker: saved?.composerModelPicker ?? composerModelPicker,
    streamReplies: saved?.streamReplies ?? streamReplies,
  };
}
