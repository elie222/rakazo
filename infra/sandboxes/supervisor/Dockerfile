FROM node:22-bookworm-slim
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/contracts packages/contracts
COPY packages/adapter-kit packages/adapter-kit
COPY packages/core packages/core
COPY infra/sandboxes/supervisor infra/sandboxes/supervisor
RUN corepack enable && pnpm install --filter "@rakazo/sandbox-supervisor..." && pnpm --filter "@rakazo/sandbox-supervisor" add tsx
WORKDIR /app/infra/sandboxes/supervisor
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
