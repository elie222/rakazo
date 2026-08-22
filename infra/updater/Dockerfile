# The updater is the only service that gets the Docker CLI and the Docker socket, so it is built
# separately from the application image rather than adding root-equivalent tooling to api, worker,
# and web. It is also the only service the update never recreates, so its own image moves on the
# operator's schedule: `docker compose pull updater && docker compose up -d updater`.
FROM docker:27-cli AS dockercli

FROM node:22-bookworm-slim
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose \
  /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx \
  /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY infra/updater infra/updater
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter "@rakazo/updater..."
WORKDIR /app/infra/updater
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
