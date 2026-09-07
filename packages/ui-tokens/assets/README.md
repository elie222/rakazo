# App icon source

`Rakazo.icon` is the shared editable source for macOS and iOS. Open it in Apple's
Icon Composer with Xcode 26 or newer. The orange foreground keeps its original
lighting, sits 90 points below center, and uses the system dark background.

macOS packaging compiles the source into a Tahoe asset catalog and generates the
legacy ICNS fallback. Expo copies the same source into the iOS project.

The platform exports are:

- `apps/desktop/assets/icon-macos.png`: Icon Composer's default appearance,
  1024-pixel macOS pre-Tahoe export, including Dock margins for development launches.
- `apps/mobile/assets/icon.png`: opaque 1024-pixel square for the generic/legacy icon,
  with no rounded mask or Dock margins.
- `apps/mobile/assets/adaptive-icon.png`: transparent 1024-pixel Android foreground;
  the bot is 820 pixels wide, centered horizontally and offset 179 pixels from the top.
  Its face stays inside the launcher's safe area and the body extends below the mask.
- `apps/mobile/assets/icon-background.png`: opaque Android background using the
  shared dark background token.
- `apps/mobile/assets/monochrome-icon.png`: matching Android alpha silhouette with
  transparent eyes for themed launchers.

Refresh platform exports after changing the source. Android supplies its own mask;
never bake Mac corners, a rim, or an outer shadow into adaptive layers.
