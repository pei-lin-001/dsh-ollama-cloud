#!/usr/bin/env bash
# Link this checkout's runtime peers from a dsh profile's node_modules.
#
# A `link:` install points the profile at this directory, so Node resolves our
# imports from HERE, not from the profile. Peer packages therefore have to be
# visible in this checkout's own node_modules — that is all this script does.
# A published copy (a real directory under the profile's node_modules) needs
# nothing: it resolves the profile's peers normally.
#
# Usage: scripts/link-peers.sh [profile]      (default: web)
set -euo pipefail
profile="${1:-web}"
root="$(cd "$(dirname "$0")/.." && pwd)"
peers="$HOME/.dsh/profiles/node_modules/@deepseek-ai"
[ -d "$peers" ] || { echo "no @deepseek-ai packages under $peers" >&2; exit 1; }

mkdir -p "$root/node_modules/@deepseek-ai"
for pkg in schemastery dsh-credentials dsh-settings dsh-tools; do
  target="$root/node_modules/@deepseek-ai/$pkg"
  [ -e "$target" ] || ln -s "$peers/$pkg" "$target"
  echo "linked $pkg -> $peers/$pkg"
done
echo "profile '$profile' peers linked; run: dsh --profile $profile"
