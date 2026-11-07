#!/bin/bash
set -euo pipefail
curl -fsSL -o apps/web/e2e/pages.spec.ts https://yellow-lights-begin.loca.lt/pages.spec.ts
sha256sum apps/web/e2e/pages.spec.ts
