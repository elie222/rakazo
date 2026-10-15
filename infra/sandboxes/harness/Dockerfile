# Trusted runtime only. The supervisor never mounts a team workspace or home here.
FROM node:22-bookworm-slim AS node-runtime
FROM python:3.13-slim-bookworm
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 harness \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/harness harness \
  && mkdir /sessions /credentials && chown 10001:10001 /sessions /credentials && chmod 0700 /sessions /credentials
RUN npm install --prefix /opt/rakazo-harness --omit=dev \
  @anthropic-ai/claude-agent-sdk@0.3.300 \
  @anthropic-ai/sdk@0.134.0 \
  @openai/codex@0.162.1 \
  @moonshot-ai/kimi-code@2.2.0 \
  @modelcontextprotocol/sdk@1.30.0 \
  zod@4.6.2 \
  && npm cache clean --force
COPY --chmod=644 launch.py /opt/rakazo-harness/launch.py
ENV PATH=/opt/rakazo-harness/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /home/harness
USER 10001:10001
CMD ["/usr/bin/true"]
