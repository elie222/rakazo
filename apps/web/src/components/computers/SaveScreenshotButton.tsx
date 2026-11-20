import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Camera } from "lucide-react";
import { decodeArtifactBase64, downloadArtifactBytes } from "../../lib/pages/artifact-open";
import { useSave } from "../../lib/query/query";
import { IconTooltip } from "../IconTooltip";

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i;
const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp" };

/** The file a still of the screen is saved as, named for when it was taken. */
export function screenshotFileName(mimeType: string, takenAt: Date): string {
  const stamp = takenAt.toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return `screen-${stamp}.${EXTENSIONS[mimeType.toLowerCase()] ?? "png"}`;
}

/** Saves a picture of what the bot's screen shows right now, for a code, a page or an error to keep. */
export function SaveScreenshotButton({ botId }: { botId: string }) {
  const { t } = useLingui();
  const capture = useSave({
    save: async (_input: undefined, rpc) => {
      const { image } = await rpc.computer.preview({ botId });
      const match = image ? DATA_URL.exec(image) : null;
      if (!match?.[1] || !match[2]) throw new Error("The computer returned no screen image");
      downloadArtifactBytes(
        screenshotFileName(match[1], new Date()),
        match[1],
        decodeArtifactBase64(match[2]),
      );
    },
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
