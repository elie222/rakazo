# The updater is the only service that gets the Docker CLI and the Docker socket, so it is built
# separately from the application image rather than adding root-equivalent tooling to api, worker,
# and web. It is also the only service the update never recreates, so its own image moves on the
# operator's schedule: `docker compose pull updater && docker compose up -d updater`.
FROM docker:29-cli@sha256:5a7af0dcb0e46c803efe9b45371dd21cb500e5b4453250394ac6f06d49b6e6f1 AS dockercli

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose \
  /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx \
  /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY infra/sandboxes/computer/apt-security.sh /tmp/apt-security.sh
RUN /tmp/apt-security.sh \
  && apt-get update && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts npm@11.21.2 && npm cache clean --force
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .pnpmfile.cjs ./
COPY patches patches
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/ui-tokens packages/ui-tokens
COPY packages/logging packages/logging
COPY infra/updater infra/updater
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter "@rakazo/updater..."
RUN /tmp/apt-security.sh --check && rm -f /tmp/apt-security.sh
WORKDIR /app/infra/updater
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
# Keep Node as the container process so SIGTERM reaches the graceful shutdown handler.
CMD ["node", "--import", "tsx", "src/index.ts"]
