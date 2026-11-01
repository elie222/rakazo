#!/bin/sh
# Installs the pinned agent-browser release into the given folder, checked against its sha256.
# The computer image, hosted computers and CI's page-browser tests all use it, so they run the
# same binary. A folder that already holds that binary is left as it is.
# The release binaries are byte-identical to the ones in the npm package, which carries
# SLSA provenance; bump the version and both hashes together.
set -eu
dest="${1:?usage: install-agent-browser.sh <folder>}"
version=0.41.0
case "$(uname -m)" in
  x86_64 | amd64) arch=x64; sha256=399c7e9f06bd29aa933fdf25c0bd958eea06927fc0ce6f536ba6347aabd64628 ;;
  aarch64 | arm64) arch=arm64; sha256=e196e9cabe6cb1b01bd5912973628361b9f40a332683a12426abad007f0d3589 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
if echo "$sha256  $dest/agent-browser" | sha256sum -c --status 2>/dev/null; then exit 0; fi
mkdir -p "$dest"
binary="$(mktemp)"
trap 'rm -f "$binary"' EXIT
curl -fsSL "https://github.com/vercel-labs/agent-browser/releases/download/v${version}/agent-browser-linux-${arch}" -o "$binary"
echo "$sha256  $binary" | sha256sum -c -
install -m 755 "$binary" "$dest/agent-browser"
"$dest/agent-browser" --version
