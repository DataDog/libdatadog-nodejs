#!/usr/bin/env bash
# Publish one package directory, tolerating a version that is already on the
# registry.
#
# Two hazards this exists for:
#
# 1. `npm publish packages/libdatadog` is not a directory publish. npm parses a
#    bare `foo/bar` argument as a GitHub owner/repo shorthand and tries to clone
#    it, so the path must be passed with an explicit `./` prefix.
# 2. The release job publishes three packages in sequence. A failure partway
#    through leaves earlier packages published, and the whole job has to be
#    re-run to finish the release. Re-publishing an existing version is an
#    E403/EEXIST error, so skip versions that are already on the registry
#    instead of failing the retry.
#
# Usage: npm-publish.sh <package-directory> <version> <npm-tag>

set -euo pipefail

directory=$1
version=$2
npm_tag=$3

# The leading ./ is required for subdirectories: without it npm treats the
# argument as a package spec rather than a directory. "." is already
# unambiguous.
if [ "$directory" = "." ]; then
  target=.
else
  target=./$directory
fi

name=$(node -p "require('$target/package.json').name")

if npm view "$name@$version" version >/dev/null 2>&1; then
  echo "$name@$version is already published; skipping."
  exit 0
fi

npm publish "$target" --access public --tag "$npm_tag"
