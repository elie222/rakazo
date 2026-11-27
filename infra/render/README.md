# Deploy and Host Rakazo on Render

The Blueprint in [`render.yaml`](../../render.yaml) runs Rakazo on one Render web service with a persistent disk and a Render Postgres database. Render cannot run Docker computers, so bot computers run at a remote computer provider. Render usage, the computer provider and any connected model provider are billed separately.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/elie222/rakazo)

1. Open the Blueprint. Enter your email in `OWNER_EMAIL`.
2. Wait for the first build and deploy to finish. Open the service's `onrender.com` address.
3. Sign in with your email and the generated `OWNER_PASSWORD` from the service's Environment tab. Change the password in account settings.
4. Connect your model account in Rakazo and send Chief a message.

The service needs a paid instance type, because Render attaches disks only to paid services. Computers are off initially. To enable them, choose a [remote computer provider](../../docs/self-host-sandbox-providers.md#remote-providers) and set `SANDBOX_PROVIDER` and its credentials in the Environment tab.

## How it runs

- The service builds a thin image on top of the published `ghcr.io/elie222/rakazo/app` release named by `RAKAZO_IMAGE_TAG`. It starts with the same entrypoint as the [Railway template](../railway/README.md).
- The initial ordinary account is created before the public web server starts. Public registration is closed on every start; this template is intended for a personal deployment.
- Every install gets separate random authentication, encryption, screen and initial owner secrets. Keep `ENCRYPTION_KEY` stable across redeploys.
- Postgres accepts connections only from Render's private network. Only the web port is published; the API binds to loopback.
- App processes run as the unprivileged `node` user. The entrypoint briefly uses root to set the disk's owner, then drops privileges.
- The API, worker and web share one service and its `/data` disk, so the service runs one instance and each deploy has a few seconds of downtime. Any process failure restarts the service. Database migrations finish before startup.
- The app connects to Postgres as the database owner, so row-level security is not enforced; startup logs a warning saying so.
- Idle computers stop after ten minutes; each user can create up to three computers.

## Custom domain

After adding a custom domain in Render, set `BETTER_AUTH_URL` to its `https://` origin and redeploy. The web origin, API URL and allowed host follow it.

## Updates and backups

Pushes to the repository never redeploy your service. To update, set `RAKAZO_IMAGE_TAG` to the release you want (or keep `latest`) and choose **Manual Deploy → Clear build cache & deploy**, so the build pulls that release again. The private account bootstrap keeps existing accounts and passwords. Changing `OWNER_PASSWORD` later does not reset an account password.

Back up Postgres, `/data`, and `ENCRYPTION_KEY` before upgrades. Render takes daily snapshots of the disk and backs up paid Postgres databases; keep your own copies as well and test restoring them together. Do not delete the disk to fix a failed deploy.
