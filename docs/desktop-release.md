# Desktop releases

The `release-desktop` workflow builds, signs, notarizes, attests, and publishes
the Electron app from a `vMAJOR.MINOR.PATCH` tag on `main`. Publishing the
Docker images triggers from the same tag.

## Repository secrets

macOS (required):

| Secret | Value |
| --- | --- |
| `DESKTOP_MAC_CSC_LINK` | Base64 of the `Developer ID Application` certificate exported as `.p12` |
| `DESKTOP_MAC_CSC_KEY_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_API_KEY_ID` | App Store Connect API key ID (the `XXXXXXXXXX` in `AuthKey_XXXXXXXXXX.p8`) |
| `APPLE_API_ISSUER` | Issuer ID shown on App Store Connect > Users and Access > Integrations |
| `APPLE_API_KEY_P8` | Contents of the `AuthKey_*.p8` file |

The API key needs the Developer role. The workflow writes it to a mode 600 file
in the runner's temp directory for the packaging step and deletes it afterwards.

`patches/app-builder-lib@26.15.3.patch` carries electron-builder PR #10101:
without it `CSC_LINK` signing fails while creating the temporary keychain. Drop
the patch once an electron-builder release includes that fix.

Windows signs through Azure Artifact Signing once it is configured, logging in
with GitHub OIDC instead of a stored secret. Create a Public Trust certificate
profile, then an app registration with the Artifact Signing Certificate Profile
Signer role on the signing account, and a `desktop-release` environment in the
repository settings. Give the app registration a federated credential whose
subject is exactly the one printed under "Federated token details" in the
release's Azure login step. This repository's OIDC subject includes owner and
repository IDs, so the plain `repo:<owner>/<repo>:environment:desktop-release`
form does not match.

| Secret | Value |
| --- | --- |
| `DESKTOP_WIN_AZURE_TENANT_ID` | Directory (tenant) ID of the app registration |
| `DESKTOP_WIN_AZURE_CLIENT_ID` | Application (client) ID of the app registration |

| Variable | Value |
| --- | --- |
| `DESKTOP_WIN_SIGNING_ENDPOINT` | The signing account's URI, such as `https://eus.codesigning.azure.net/` |
| `DESKTOP_WIN_SIGNING_ACCOUNT` | The signing account name |
| `DESKTOP_WIN_SIGNING_PROFILE` | The certificate profile name |
| `DESKTOP_WIN_PUBLISHER` | The certificate's common name, exactly as validated |

When `DESKTOP_WIN_AZURE_CLIENT_ID` is unset the Windows installer ships
unsigned, and Windows shows a SmartScreen warning on first launch. Unsigned
builds carry no publisher in their update config, so they accept the first
signed update; from then on updates must match the publisher. The release is
only published when every platform produced its installer and update feed.

Set a secret from a file without echoing it:

```sh
base64 -i devid.p12 | gh secret set DESKTOP_MAC_CSC_LINK
gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
```

## Cut a release

1. Bump `version` in `apps/desktop/package.json` on `main`.
2. Tag that commit `v<version>` and push the tag:

```sh
git tag v0.1.1
git push origin v0.1.1
```

The workflow refuses tags that do not match the desktop version, are not on
`main`, or are not newer than the latest published release.
