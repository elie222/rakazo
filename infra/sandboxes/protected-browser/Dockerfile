FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f

WORKDIR /opt/protected-browser
COPY infra/sandboxes/protected-browser/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY infra/sandboxes/protected-browser/browser.mjs infra/sandboxes/protected-browser/egress.mjs ./

USER pwuser
ENTRYPOINT ["timeout", "--signal=KILL", "65s", "node", "browser.mjs"]
