import type { ChatPreferences } from "@rakazo/contracts";
import { composerModelPickerPreference } from "../models/composer-model-picker-preference";
import { responseStreamingPreference } from "./response-streaming";

export const deviceChatPreferences = {
  composerModelPicker: composerModelPickerPreference,
  streamReplies: responseStreamingPreference,
};

export function useChatPreferences(saved: ChatPreferences | undefined) {
  const composerModelPicker = deviceChatPreferences.composerModelPicker.use();
  const streamReplies = deviceChatPreferences.streamReplies.use();
  return {
    composerModelPicker: saved?.composerModelPicker ?? composerModelPicker,
    streamReplies: saved?.streamReplies ?? streamReplies,
  };
}
