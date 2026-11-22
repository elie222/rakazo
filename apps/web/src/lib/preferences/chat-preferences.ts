import type { ChatPreferences } from "@rakazo/contracts";
import { toolActivityPreference } from "../chat/tool-activity-preference";
import { composerModelPickerPreference } from "../models/composer-model-picker-preference";
import { responseStreamingPreference } from "./response-streaming";

export const deviceChatPreferences = {
  composerModelPicker: composerModelPickerPreference,
  streamReplies: responseStreamingPreference,
  showToolActivity: toolActivityPreference,
};

export function useChatPreferences(saved: ChatPreferences | undefined) {
  const composerModelPicker = deviceChatPreferences.composerModelPicker.use();
  const streamReplies = deviceChatPreferences.streamReplies.use();
  const showToolActivity = deviceChatPreferences.showToolActivity.use();
  return {
    composerModelPicker: saved?.composerModelPicker ?? composerModelPicker,
    streamReplies: saved?.streamReplies ?? streamReplies,
    showToolActivity: saved?.showToolActivity ?? showToolActivity,
  };
}
