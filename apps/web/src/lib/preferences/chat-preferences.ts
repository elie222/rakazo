import type { ChatPreferences } from "@rakazo/contracts";
import { toolActivityPreference } from "../chat/tool-activity-preference";
import { composerEnterToSendPreference } from "../composer/composer-enter-to-send-pref";
import { composerModelPickerPreference } from "../models/composer-model-picker-preference";
import { responseStreamingPreference } from "./response-streaming";

export const deviceChatPreferences = {
  composerModelPicker: composerModelPickerPreference,
  streamReplies: responseStreamingPreference,
  sendWithEnter: composerEnterToSendPreference,
  showToolActivity: toolActivityPreference,
};

export function useChatPreferences(saved: ChatPreferences | undefined) {
  const composerModelPicker = deviceChatPreferences.composerModelPicker.use();
  const streamReplies = deviceChatPreferences.streamReplies.use();
  const sendWithEnter = deviceChatPreferences.sendWithEnter.use();
  const showToolActivity = deviceChatPreferences.showToolActivity.use();
  return {
    composerModelPicker: saved?.composerModelPicker ?? composerModelPicker,
    streamReplies: saved?.streamReplies ?? streamReplies,
    sendWithEnter: saved?.sendWithEnter ?? sendWithEnter,
    showToolActivity: saved?.showToolActivity ?? showToolActivity,
  };
}
