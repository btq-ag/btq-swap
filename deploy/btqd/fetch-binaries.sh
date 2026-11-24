#!/usr/bin/env bash
# Copy the official BTQ Core v0.5.0-testnet linux binaries into deploy/btqd/bin and verify them.
# Source: a local btq-core checkout's release-artifacts, or `gh release download v0.5.0-testnet -R btq-ag/BTQ-Core`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="${BTQ_RELEASE_DIR:-$HOME/BTQ/btq-core/release-artifacts/v0.5.0-testnet/linux-x86_64}"
mkdir -p "$here/bin"
if [[ -x "$src/btqd" ]]; then
  cp "$src/btqd" "$src/btq-cli" "$here/bin/"
else
  tmp="$(mktemp -d)"
  gh release download v0.5.0-testnet -R btq-ag/BTQ-Core -p 'linux-x86_64.zip' -D "$tmp"
  unzip -q -o "$tmp/linux-x86_64.zip" -d "$tmp"
  cp "$tmp"/*/btqd "$tmp"/*/btq-cli "$here/bin/" 2>/dev/null || cp "$tmp"/btqd "$tmp"/btq-cli "$here/bin/"
fi
chmod +x "$here/bin/btqd" "$here/bin/btq-cli"
"$here/bin/btqd" --version | head -1
sha256sum "$here/bin/btqd" "$here/bin/btq-cli" | tee "$here/bin/SHA256SUMS"
