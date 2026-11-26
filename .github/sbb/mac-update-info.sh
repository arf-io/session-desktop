#!/usr/bin/env bash
# Session, but Better: write the macOS update feed (better-mac.yml) for one release.
#
#   .github/sbb/mac-update-info.sh <version> <zip>... > better-mac.yml
#
# The arm64 and x64 builds run in separate jobs, and each would write its own better-mac.yml
# naming only its zip. The in-app updater needs one file listing both: on Apple silicon it takes
# the zip with "arm64" in its name, on Intel it takes the other. The universal zip is left out on
# purpose, so an Intel Mac never picks it; a universal install updates to its own architecture's
# zip, which is the smaller download. Each zip's .blockmap must be uploaded next to it.
set -euo pipefail

version=$1
shift
[ "$#" -gt 0 ] || { echo "usage: $0 <version> <zip>..." >&2; exit 2; }

sha512() { openssl dgst -sha512 -binary "$1" | base64 | tr -d '\n'; }
size() { wc -c <"$1" | tr -d ' '; }

echo "version: ${version}"
echo "files:"
for zip in "$@"; do
  echo "  - url: $(basename "$zip")"
  echo "    sha512: $(sha512 "$zip")"
  echo "    size: $(size "$zip")"
done
# legacy single-file fields: older updaters read these; point them at the first zip
echo "path: $(basename "$1")"
echo "sha512: $(sha512 "$1")"
echo "releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'"
