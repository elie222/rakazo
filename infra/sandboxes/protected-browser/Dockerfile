FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /opt/protected-browser
COPY infra/sandboxes/protected-browser/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY infra/sandboxes/protected-browser/browser.mjs infra/sandboxes/protected-browser/egress.mjs ./

USER pwuser
ENTRYPOINT ["timeout", "--signal=KILL", "65s", "node", "browser.mjs"]
