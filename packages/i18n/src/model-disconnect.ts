import { i18n } from "@lingui/core";
import type { ModelDisconnectPreview } from "@rakazo/contracts";

/** The warning shared by the web and mobile disconnect confirmations. */
export function modelDisconnectWarning(preview: ModelDisconnectPreview | null): string {
  if (!preview) return "";
  const parts: string[] = [];
  if (preview.mainModel && preview.otherChoice) {
    parts.push(
      i18n._({
        id: "Reconnecting will not restore the main model choice or other choices that use this connection.",
        message:
          "Reconnecting will not restore the main model choice or other choices that use this connection.",
      }),
    );
  } else if (preview.mainModel) {
    parts.push(
      i18n._({
        id: "Reconnecting will not restore the main model choice that uses this connection.",
        message: "Reconnecting will not restore the main model choice that uses this connection.",
      }),
    );
  } else if (preview.otherChoice) {
    parts.push(
      i18n._({
        id: "Reconnecting will not restore saved model choices that use this connection.",
        message: "Reconnecting will not restore saved model choices that use this connection.",
      }),
    );
  }
  if (preview.usedBy.length > 0) {
    const names = preview.usedBy.join(", ");
    const more = preview.usedByTotal - preview.usedBy.length;
    parts.push(
      more > 0
        ? i18n._({
            id: "{names} and {more} more may stop until you reconnect.",
            message: "{names} and {more} more may stop until you reconnect.",
            values: { names, more },
          })
        : i18n._({
            id: "{names} may stop until you reconnect.",
            message: "{names} may stop until you reconnect.",
            values: { names },
          }),
    );
  } else if (preview.usedByTotal > 0) {
    parts.push(
      i18n._({
        id: "Bots and routines that rely on this connection may stop.",
        message: "Bots and routines that rely on this connection may stop.",
      }),
    );
  }
  return parts.join(" ");
}
