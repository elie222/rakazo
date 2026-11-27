#!/usr/bin/env bash
# Write the profile to the absolute path passed as seccompProfile to the launcher.
set -euo pipefail

profile="$(mktemp)"
trap 'rm -f "$profile"' EXIT
curl -fsSL https://raw.githubusercontent.com/microsoft/playwright/v1.64.1/utils/docker/seccomp_profile.json -o "$profile"
printf '%s  %s\n' cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849 "$profile" | shasum -a 256 -c >/dev/null

# Chromium chroots its zygote using CAP_SYS_CHROOT inside its own user namespace.
# Docker still drops all container capabilities, and the kernel checks chroot's capability.
jq '(.syscalls[] | select(.names == ["chroot"]) | .includes) = {}' "$profile"
