# Mock sites for the Rakazo harness lab: build from the repo root,
#   docker build -f harness-lab/Dockerfile -t harness-lab/mocks .
# Serves every site from one process (ports 7000-7003 and 7011). Publish ports on 127.0.0.1 only,
# or attach the container to a private docker network; the sites hold fake data but are not hardened.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
# A Hebrew-capable font so the generated PDFs carry Hebrew headings.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY patches patches
COPY harness-lab/package.json harness-lab/package.json
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter "@rakazo/harness-lab..."
COPY harness-lab/tsconfig.json harness-lab/tsconfig.json
COPY tsconfig.base.json tsconfig.base.json
COPY harness-lab/src harness-lab/src
COPY harness-lab/fixtures harness-lab/fixtures
WORKDIR /app/harness-lab
ENV HARNESS_LAB_BIND=0.0.0.0
EXPOSE 7000 7001 7002 7003 7011
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.HARNESS_LAB_PORT_BASE||7000)+'/api/health',{headers:{'x-lab-token':process.env.HARNESS_LAB_TOKEN||''}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
