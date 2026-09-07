# Desktop icons

`Rakazo.icon` is the editable macOS source. Open it in Apple's Icon Composer.
The orange foreground keeps its original lighting, sits 90 points below center,
and uses the system dark background for the tile's edge highlight.

macOS packaging requires Xcode 26 or newer. Electron builder compiles this source
into `Assets.car` for Tahoe and generates `icon.icns` for older macOS versions.

`icon-macos.png` is the 1024-pixel, default-appearance, macOS pre-Tahoe PNG export
from Icon Composer. It includes Dock margins and is used by unpackaged development
launches. Refresh it after changing the source; do not add a second inset or mask.

`icon.png` and `icon.ico` remain the Linux and Windows assets.
