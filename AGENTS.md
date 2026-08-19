# AGENTS.md

- This is a public repository: assume all tracked content and diffs are public. Never commit secrets, `.env` files, private URLs, personal/customer data, or real production data; use fake placeholders. Review `git status` and the staged diff before committing, and never force-add ignored files. If private data appears, stop and alert the maintainer.
- Rakazo targets web, Electron desktop, and Expo mobile; Electron hosts the web UI. Consider every surface when changing features or contracts.
- Prefer shared packages for domain logic, contracts, API behavior, and reusable UI. Keep genuinely native navigation, storage, permissions, and interactions platform-specific.
- Treat auth, secret handling, sandbox boundaries, host commands, and integrations as security-sensitive. Keep tests deterministic and offline by default.
- After creating a pull request, stay with it until CI and automated review bots have finished. Poll checks, reviews, review threads, and PR comments at roughly 60-second intervals; passing checks alone do not mean the review is complete. Address every actionable issue, push the fixes, and repeat the review cycle until no actionable feedback remains. Do not merge while review bots are still pending or review issues remain unresolved.
