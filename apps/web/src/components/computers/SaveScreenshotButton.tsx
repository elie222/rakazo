import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Camera } from "lucide-react";
import { decodeArtifactBase64, downloadArtifactBytes } from "../../lib/pages/artifact-open";
import { useSave } from "../../lib/query/query";
import { IconTooltip } from "../IconTooltip";

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i;

/** The file a still of the screen is saved as, named for when it was taken on the user's clock. */
export function screenshotFileName(mimeType: string, takenAt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = [
    takenAt.getFullYear(),
    pad(takenAt.getMonth() + 1),
    pad(takenAt.getDate()),
    pad(takenAt.getHours()),
    pad(takenAt.getMinutes()),
    pad(takenAt.getSeconds()),
  ].join("-");
  const subtype = mimeType.toLowerCase().split("/")[1]?.split("+")[0] ?? "png";
  return `screen-${stamp}.${subtype === "jpeg" ? "jpg" : subtype}`;
}

/** Saves a picture of what the bot's screen shows right now, for a code, a page or an error to keep. */
export function SaveScreenshotButton({ botId }: { botId: string }) {
  const { t } = useLingui();
  const capture = useSave({
    save: async (_input: undefined, rpc) => {
      const { image } = await rpc.computer.preview({ botId });
      const match = image ? DATA_URL.exec(image) : null;
      if (!match?.[1] || !match[2]) throw new Error("The computer returned no screen image");
      return { mimeType: match[1], bytes: decodeArtifactBase64(match[2]) };
    },
    // Only while the same account, Space and view are still shown, so a late answer saves nothing.
    onSaved: ({ mimeType, bytes }) =>
      downloadArtifactBytes(screenshotFileName(mimeType, new Date()), mimeType, bytes),
  });
  return (
    <>
      {capture.error ? (
        <span role="alert" className="text-body-sm text-destructive">
          {t`Could not save screenshot`}
        </span>
      ) : null}
      <IconTooltip label={t`Save screenshot`}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={t`Save screenshot`}
          disabled={capture.pending}
          onClick={() => capture.run(undefined)}
        >
          <Camera size={16} strokeWidth={1.8} />
        </Button>
      </IconTooltip>
    </>
  );
}
