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
  if (preview.mainModel) {
    parts.push(
      i18n._({
        id: "Your main model choice is cleared, and connecting again does not bring it back.",
        message: "Your main model choice is cleared, and connecting again does not bring it back.",
      }),
    );
  } else if (preview.backupModel) {
    parts.push(
      i18n._({
        id: "A backup model choice is cleared, and connecting again does not bring it back.",
        message: "A backup model choice is cleared, and connecting again does not bring it back.",
      }),
    );
  }
  if (preview.usedBy.length > 0) {
    const names = preview.usedBy.slice(0, SHOWN).join(", ");
    const more = preview.usedBy.length - SHOWN;
    parts.push(
      more > 0
        ? i18n._({
            id: "Until it is connected again, runs stop for: {names} and {more} more.",
            message: "Until it is connected again, runs stop for: {names} and {more} more.",
            values: { names, more },
          })
        : i18n._({
            id: "Until it is connected again, runs stop for: {names}.",
            message: "Until it is connected again, runs stop for: {names}.",
            values: { names },
          }),
    );
  }
  return parts.join(" ");
}
