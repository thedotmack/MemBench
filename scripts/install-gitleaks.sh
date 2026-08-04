#!/usr/bin/env bash
set -euo pipefail

readonly VERSION='8.30.1'
readonly LINUX_X64_SHA256='551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
readonly DARWIN_ARM64_SHA256='b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'

destination="${1:-}"
if [ -z "$destination" ]; then
  printf 'install-gitleaks: destination directory required\n' >&2
  exit 2
fi

case "$(uname -s):$(uname -m)" in
  Linux:x86_64) archive="gitleaks_${VERSION}_linux_x64.tar.gz"; expected="$LINUX_X64_SHA256" ;;
  Darwin:arm64) archive="gitleaks_${VERSION}_darwin_arm64.tar.gz"; expected="$DARWIN_ARM64_SHA256" ;;
  *) printf 'install-gitleaks: unsupported platform\n' >&2; exit 2 ;;
esac

temp_root="$(mktemp -d "${TMPDIR:-/tmp}/membench-gitleaks.XXXXXX")"
cleanup() {
  case "${temp_root##*/}" in
    membench-gitleaks.*) rm -rf -- "$temp_root" ;;
  esac
}
trap cleanup EXIT
trap 'exit 2' HUP INT TERM

curl --fail --silent --show-error --location \
  --output "$temp_root/$archive" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${archive}"
actual="$(shasum -a 256 "$temp_root/$archive" | awk '{print $1}')"
[ "$actual" = "$expected" ] || { printf 'install-gitleaks: checksum mismatch\n' >&2; exit 2; }
tar -xzf "$temp_root/$archive" -C "$temp_root" gitleaks
mkdir -p -- "$destination"
install -m 0755 "$temp_root/gitleaks" "$destination/gitleaks"
"$destination/gitleaks" version >/dev/null
