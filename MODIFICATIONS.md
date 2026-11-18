# Modifications

This repository is a fork of **Rakazo** (`https://github.com/elie222/rakazo`),
licensed under the Apache License, Version 2.0. Ciphers Lab maintains this fork
and distributes it under the **Nurlai** brand.

Upstream copyright, the `LICENSE` file and the `NOTICE` file are retained
unmodified. The upstream project's third-party attributions (including the MIT
notice from Nous Research) remain in `NOTICE` and ship with the product.

Nurlai is not affiliated with, endorsed by, or sponsored by the Rakazo project.
"Rakazo" is used only to describe the origin of this work.

## 2026-11-18: Rebrand pass 1 (visible branding)

- Replaced the standalone display name `Rakazo` with `Nurlai` across web,
  desktop, mobile, shared UI copy and their translation catalogs (1,388
  occurrences in 180 files).
- Updated the web `<title>`, PWA title, Electron `productName` and author, and
  the Expo app name.
- Renamed the shared app icon bundle from `Rakazo.icon` to `Nurlai.icon` and
  updated every reference, including CI artifact paths.
- Left internal identifiers unchanged on purpose: `@rakazo/*` package scopes,
  `RAKAZO_*` environment variables, database names, cookie names, deep links,
  app slugs, native module names, and `rakazo.com` URLs. These move in a
  separate, coordinated pass because they affect deployments and upgrades.

### Re-applying after an upstream merge

The rename is automated so it can be replayed on top of new upstream releases:

```
node scripts/rebrand/brand.mjs --check   # dry run, prints the diff size
node scripts/rebrand/brand.mjs --write   # apply
```

`LICENSE` and `NOTICE` are excluded from the codemod by design.
