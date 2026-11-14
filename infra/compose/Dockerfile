FROM node:24.22.2-bookworm@sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40 AS manifests
# pnpm lives in the image so containers start without downloading it.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
WORKDIR /app
# Manifests land before the source tree so editing a source file does not re-run the
# install. pnpm gets a partial workspace: every package listed in pnpm-workspace.yaml
# needs its manifest below, or --frozen-lockfile fails. The store is a cache mount, so
# a lockfile change reuses whatever was already downloaded.
COPY --chmod=755 package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
# The first run fetches pnpm's native binary into COREPACK_HOME; the runtime, which may have no
# network, copies it from here.
RUN corepack install && pnpm --version >/dev/null && chmod -R a+rX "${COREPACK_HOME}"
COPY --chmod=755 patches patches
COPY --chmod=755 apps/api/package.json apps/api/
COPY --chmod=755 apps/desktop/package.json apps/desktop/
COPY --chmod=755 apps/mobile/package.json apps/mobile/
COPY --chmod=755 apps/web/package.json apps/web/
COPY --chmod=755 apps/worker/package.json apps/worker/
COPY --chmod=755 apps/www/package.json apps/www/
COPY --chmod=755 packages/adapter-kit/package.json packages/adapter-kit/
COPY --chmod=755 packages/adapters/package.json packages/adapters/
COPY --chmod=755 packages/auth/package.json packages/auth/
COPY --chmod=755 packages/chat-ui/package.json packages/chat-ui/
COPY --chmod=755 packages/contracts/package.json packages/contracts/
COPY --chmod=755 packages/core/package.json packages/core/
COPY --chmod=755 packages/db/package.json packages/db/
COPY --chmod=755 packages/i18n/package.json packages/i18n/
COPY --chmod=755 packages/logging/package.json packages/logging/
COPY --chmod=755 packages/memory/package.json packages/memory/
COPY --chmod=755 packages/page-kit/package.json packages/page-kit/
COPY --chmod=755 packages/testkit/package.json packages/testkit/
COPY --chmod=755 packages/ui-tokens/package.json packages/ui-tokens/
COPY --chmod=755 packages/ui-web/package.json packages/ui-web/
COPY --chmod=755 infra/sandboxes/supervisor/package.json infra/sandboxes/supervisor/
COPY --chmod=755 infra/updater/package.json infra/updater/
# Production dependencies get their own stage, built from the manifests alone, so the runtime's
# largest layer stays byte-identical until the lockfile changes and a deploy downloads only the
# app's own files.
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prod \
  --store-dir=/pnpm/store --cpu=current --os=current \
  --filter="@rakazo/api..." --filter="@rakazo/worker..." \
  --filter="@rakazo/web..." --filter="@rakazo/sandbox-supervisor..."

FROM manifests AS build
# Only what the image runs (api, worker, web, supervisor) and the root build tools, with
# native binaries for this image's platform alone. Mobile, desktop and the marketing site
# never run here.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile \
  --store-dir=/pnpm/store --cpu=current --os=current \
  --filter=. --filter="@rakazo/api..." --filter="@rakazo/worker..." \
  --filter="@rakazo/web..." --filter="@rakazo/sandbox-supervisor..."
# Normalize modes: a restrictive host umask (e.g. 077 on hardened hosts) would otherwise
# leave the copied tree unreadable to USER node at runtime.
COPY --chmod=755 . .
RUN pnpm --filter @rakazo/db generate
RUN pnpm --filter @rakazo/api --filter @rakazo/worker build
RUN RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build
# Build and test tooling stays here; the runtime takes its dependencies from the deps stage.
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
  && rm -rf apps/desktop apps/mobile apps/www docs examples

# Tailscale's static binaries, pinned and checked by sha256. The API runs one userspace tailscaled
# per bot node that joins a person's tailnet; no kernel device or extra privilege is needed.
FROM node:24.22.2-bookworm@sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40 AS tailscale
ARG TARGETARCH
ARG TAILSCALE_VERSION=1.104.4
RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) ts_sha256=624ea093d47d62cf56f17b8332d74b8decda4a1faa610ebc60a1de334b2b3dc9 ;; \
    arm64) ts_sha256=a1c249ce6bdebef62e1ae3b997595555bce2ae4709bf95a718e9ca7a129dad7e ;; \
    *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  archive="$(mktemp)"; \
  curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}.tgz" -o "$archive"; \
  echo "$ts_sha256  $archive" | sha256sum -c -; \
  mkdir -p /out; \
  tar -xzf "$archive" -C /out --strip-components=1 \
    "tailscale_${TAILSCALE_VERSION}_${TARGETARCH}/tailscaled" "tailscale_${TAILSCALE_VERSION}_${TARGETARCH}/tailscale"; \
  rm -f "$archive"; \
  /out/tailscale version

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
COPY infra/sandboxes/computer/apt-security.sh /tmp/apt-security.sh
RUN /tmp/apt-security.sh
# Prisma's migration engine detects and links against OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
ENV COREPACK_HOME=/usr/local/share/corepack
COPY --from=manifests /usr/local/share/corepack /usr/local/share/corepack
RUN corepack enable
WORKDIR /app
# --link keeps each layer independent of the ones below, so an unchanged one is reused as is.
COPY --link --from=deps /app /app
COPY --link --from=build /app /app
COPY --link --from=tailscale /out/tailscaled /out/tailscale /usr/local/bin/
RUN install -d -m 750 -o node -g node /data /app/apps/web/node_modules/.vite-temp /app/apps/web/asset-archive
# Last root step, so a cached earlier layer cannot be the filesystem that ships.
RUN /tmp/apt-security.sh --check && rm -f /tmp/apt-security.sh
ARG GIT_SHA
ENV NODE_ENV=production
ENV GIT_SHA=$GIT_SHA
EXPOSE 3100 5173 7091
USER node
CMD ["pnpm", "--filter", "@rakazo/api", "start"]
