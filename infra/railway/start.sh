#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $(id -u) == 0 ]]; then
  install -d -m 750 -o node -g node /data
  exec gosu node "$0"
fi

export RAILWAY_ENVIRONMENT_ID
RAILWAY_ENVIRONMENT_ID=$(node infra/railway/sandbox-environment.mjs)
pnpm --filter @rakazo/db exec prisma migrate deploy
pnpm --filter @rakazo/api exec tsx src/cli/bootstrap-owner.ts
unset OWNER_PASSWORD

# All processes share one volume; a failed process restarts the whole service.
trap 'kill $(jobs -pr) 2>/dev/null || true; wait || true' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
pnpm --filter @rakazo/api start &
pnpm --filter @rakazo/worker start &
(
  node --input-type=module -e '
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = await fetch("http://127.0.0.1:3100/ready", { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false);
    if (ready) process.exit(0);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("API did not become ready");
'
  exec env -u RAILWAY_API_TOKEN -u DATABASE_URL -u ENCRYPTION_KEY -u BETTER_AUTH_SECRET \
    pnpm --filter @rakazo/web preview --host 0.0.0.0 --port 5173
) &
wait -n
exit 1
