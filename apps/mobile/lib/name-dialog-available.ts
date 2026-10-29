import { isComposeViewAvailable } from "./compose-available";

export function isNameDialogAvailable(): boolean {
  return [
    "HostView",
    "AlertDialogView",
    "SlotView",
    "TextFieldView",
    "TextButton",
    "TextView",
  ].every(isComposeViewAvailable);
}
