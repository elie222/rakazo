FROM node:22-bookworm
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @rakazo/db generate
RUN RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build
RUN install -d -m 750 -o node -g node /data /app/apps/web/node_modules/.vite-temp
ENV NODE_ENV=production
EXPOSE 3100 5173 7091
USER node
CMD ["pnpm", "--filter", "@rakazo/api", "start"]
