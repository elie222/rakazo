FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
COPY infra/sandboxes/computer/apt-security.sh /tmp/apt-security.sh
RUN /tmp/apt-security.sh \
  && apt-get update && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts npm@11.21.2 && npm cache clean --force
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .pnpmfile.cjs ./
COPY patches patches
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/ui-tokens packages/ui-tokens
COPY packages/logging packages/logging
COPY infra/sandboxes/supervisor infra/sandboxes/supervisor
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter "@rakazo/sandbox-supervisor..."
RUN /tmp/apt-security.sh --check && rm -f /tmp/apt-security.sh
WORKDIR /app/infra/sandboxes/supervisor
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
