import { i18n } from "@lingui/core";
import type { ModelDisconnectPreview } from "@rakazo/contracts";

/** Names shown before the rest are counted. */
const SHOWN = 3;

/**
 * What disconnecting a model connection takes with it, for the question that asks first. Both
 * apps show it, so the copy and its choice can't drift between them. Empty when the connection
 * serves nothing, or when the preview could not be read. Static descriptors keep it in Lingui
 * extraction.
 */
export function modelDisconnectWarning(preview: ModelDisconnectPreview | null): string {
  if (!preview) return "";
  const parts: string[] = [];
  if (preview.mainModel && preview.otherChoice) {
    parts.push(
      i18n._({
        id: "Your main model choice and others that use it are cleared, and connecting again does not bring them back.",
        message:
          "Your main model choice and others that use it are cleared, and connecting again does not bring them back.",
      }),
    );
  } else if (preview.mainModel) {
    parts.push(
      i18n._({
        id: "Your main model choice is cleared, and connecting again does not bring it back.",
        message: "Your main model choice is cleared, and connecting again does not bring it back.",
      }),
    );
  } else if (preview.otherChoice) {
    parts.push(
      i18n._({
        id: "A model choice that uses it is cleared, and connecting again does not bring it back.",
        message:
          "A model choice that uses it is cleared, and connecting again does not bring it back.",
      }),
    );
  }
  if (preview.usedBy.length > 0) {
    const names = preview.usedBy.slice(0, SHOWN).join(", ");
    // Counted from the server's total: the names it sends are only the first of them.
    const more = Math.max(preview.usedByTotal, preview.usedBy.length) - SHOWN;
    parts.push(
      more > 0
        ? i18n._({
            id: "These use it and may stop until it is connected again: {names} and {more} more.",
            message:
              "These use it and may stop until it is connected again: {names} and {more} more.",
            values: { names, more },
          })
        : i18n._({
            id: "These use it and may stop until it is connected again: {names}.",
            message: "These use it and may stop until it is connected again: {names}.",
            values: { names },
          }),
    );
  }
  return parts.join(" ");
}
