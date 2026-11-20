# App icon source

`BotONE.icon` is the shared editable source for macOS and iOS. Open it in Apple's
Icon Composer with Xcode 26 or newer. The BotONE foreground is centered on the system dark background.
Platform exports keep their existing filenames so asset consumers need no changes.

macOS packaging compiles the source into a Tahoe asset catalog and generates the
legacy ICNS fallback. Expo copies the same source into the iOS project.

The platform exports are:

- `apps/desktop/assets/icon-macos.png`: Icon Composer's default appearance,
  1024-pixel macOS pre-Tahoe export, including Dock margins for development launches.
- `apps/mobile/assets/icon.png`: opaque 1024-pixel square for the generic/legacy icon,
  with no rounded mask or Dock margins.
- `apps/mobile/assets/adaptive-icon.png`: transparent 1024-pixel Android foreground;
  the 820-pixel foreground canvas is centered inside the launcher safe area.
- `apps/mobile/assets/icon-background.png`: opaque Android background using the
  shared dark background token.
- `apps/mobile/assets/monochrome-icon.png`: matching Android alpha silhouette for themed launchers.

Refresh platform exports after changing the source. Android supplies its own mask;
never bake Mac corners, a rim, or an outer shadow into adaptive layers.

Run `pnpm --filter @rakazo/ui-tokens export:brand` to refresh the web and marketing
favicons, install icons, marketing mark, Windows/Linux icons, mobile splash, and
mobile web favicon, and native launcher exports. These use the same orange foreground with the shared dark
background, a rounded mask for small browser marks, and transparent splash padding.
The notification export uses the Android monochrome silhouette. Apple packaging
compiles the shared Icon Composer source with the platform's own mask.

After exporting, run `pnpm exec tsx apps/www/src/marketing/scripts/render-og.mjs` (the private marketing pages) to refresh the
marketing page social cards; set `CHROME_PATH` to a headless Chrome executable when
it is not available at the script's default location.

## Animated vector avatars

The animated bot avatar uses SVG paths and gradients in the shared
`logo-avatar-art.ts` definition. Its reference remains `Rakazo.icon`, independently
of the BotONE application mark. The avatar and its motion remain unchanged when
refreshing application icons.
