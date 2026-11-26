FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /opt/protected-browser
COPY infra/sandboxes/protected-browser/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY infra/sandboxes/protected-browser/browser.mjs ./

USER pwuser
ENTRYPOINT ["node", "browser.mjs"]
