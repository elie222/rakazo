import { BOT_COLOR_LIST } from "@rakazo/core";
import { BotAvatar } from "@rakazo/ui-web";

/** The palette's blue, the same as the link colour. */
const BLUE = BOT_COLOR_LIST.find((color) => color.id === "blue")?.hex ?? "";

/** The Rakazo mark on the entry pages: the head new bots get. */
export function BrandMark() {
  return (
    <span aria-hidden="true" className="shrink-0">
      <BotAvatar activity="idle" avatarSet="rakazo" color={BLUE} identity="rakazo" size={74} />
    </span>
  );
}
