import { notificationAvatarSource } from "@rakazo/core";

const ICON_SIZE = 96;
/** By bot id, keyed on the avatar inputs so an edited avatar renders again. */
const icons = new Map<string, { key: string; icon: Promise<string | undefined> }>();

// Chromium and Electron do not reliably draw SVG notification icons.
function rasterize(svgUrl: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = ICON_SIZE;
        canvas.height = ICON_SIZE;
        const context = canvas.getContext("2d");
        if (!context) return resolve(undefined);
        context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(undefined);
      }
    };
    image.onerror = () => resolve(undefined);
    image.src = svgUrl;
  });
}

/** The bot's avatar as a notification icon, or undefined to keep the browser default. */
export function notificationIcon(bot: {
  id: string;
  color: string;
  avatarSet?: string | null;
}): Promise<string | undefined> {
  const key = `${bot.avatarSet ?? ""}\n${bot.color}`;
  let cached = icons.get(bot.id);
  if (cached?.key !== key) {
    const source = notificationAvatarSource(bot);
    cached = {
      key,
      icon: source.startsWith("data:image/svg+xml,") ? rasterize(source) : Promise.resolve(source),
    };
    icons.set(bot.id, cached);
  }
  return cached.icon;
}
