#!/bin/sh
# Regenerate the packer goldens from the reference Go implementation
# (docker/sbx-kits-contrib spec). Run after editing kit/spec.yaml.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
golden="$here/../provisioner/tests/golden"
fixtures="$here/../provisioner/tests/fixtures"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cd "$here/kitpack-go"
go run . "$here/../kit" > "$golden/hermes-serve.json"
mkdir -p "$tmp/claude" && cp "$fixtures/claude-spec.yaml" "$tmp/claude/spec.yaml"
go run . "$tmp/claude" > "$golden/claude.json"
echo "regenerated $(ls "$golden")"
