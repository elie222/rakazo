FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN corepack enable && pnpm add tsx hono @hono/node-server dockerode zod
COPY src ./src
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
