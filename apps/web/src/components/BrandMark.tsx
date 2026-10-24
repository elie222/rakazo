import { BOT_COLOR_LIST } from "@rakazo/core";
import { BotAvatar } from "@rakazo/ui-web";

/** The palette's blue, the same as the link colour. */
const BLUE = BOT_COLOR_LIST.find((color) => color.id === "blue")?.hex ?? "";

/** The Rakazo mark on the entry pages and in onboarding: the app's own bot head. */
export function BrandMark({ size = 74 }: { size?: number }) {
  return (
    <span aria-hidden="true" className="shrink-0">
      <BotAvatar color={BLUE} identity="rakazo" size={size} />
    </span>
  );
}
