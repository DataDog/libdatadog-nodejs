#!/usr/bin/env bash
set -e

# Usage: test.sh <native|wasm> [crate]
#
# The two suites are kept apart because the native prebuildify matrix only ever
# has the native prebuilds available:
#
#   native  Everything loaded through the loader at the repository root. This is
#           what `yarn test` runs, including inside that matrix.
#   wasm    The wasm crates, one directory per crate under test/wasm. Pass a
#           crate name to run only that crate's tests, which is what CI does
#           after building a single wasm module.

mode=$1
crate=$2

if [ "$mode" != 'native' ] && [ "$mode" != 'wasm' ]; then
  echo "usage: $0 <native|wasm> [crate]" >&2
  exit 1
fi

# `--test-force-exit` exists on Node >= 20.14/22 but Node 18 rejects it as an
# unknown option.
force_exit=false
if node --test-force-exit --eval '' >/dev/null 2>&1; then
  force_exit=true
fi

run_test() {
  local dir
  dir=$(dirname "$1")
  if [ -f "${dir}/package.json" ]; then
    echo "Installing dependencies for $1"
    yarn --cwd "$dir" install
  fi

  # node:test does not force the process to exit when the event loop is kept
  # active by async work that has already settled (e.g. the wasm trace
  # exporter's runtime machinery after a flush). For the long-lived real
  # consumer that is expected; for the test runner we force a clean exit once
  # all tests have finished. Node 18 both lacks the flag and leaves a mock-agent
  # socket open in the wasm HTTP client, so node:test cannot exit cleanly there
  # at all; those suites are covered by every newer Node in the matrix.
  if grep -q 'node:test' "$1"; then
    if [ "$force_exit" = 'false' ]; then
      echo "Skipping $1 (no --test-force-exit on this Node; covered by newer Node)"
      return
    fi

    echo "Running $1"
    node --test-force-exit "$1"
  else
    echo "Running $1"
    node "$1"
  fi
}

if [ "$mode" = 'native' ]; then
  # Top-level test files, plus the entry point of every test directory other
  # than the wasm ones.
  for f in test/*.js; do
    run_test "$f"
  done

  for d in test/*/; do
    [ "$d" = 'test/wasm/' ] && continue
    [ -f "${d}index.js" ] && run_test "${d}index.js"
  done
else
  if [ -n "$crate" ] && [ ! -d "test/wasm/$crate" ]; then
    echo "No wasm tests for crate '$crate' (expected test/wasm/$crate)" >&2
    exit 1
  fi

  for d in test/wasm/${crate:-*}/; do
    for f in "$d"*.js; do
      [ -f "$f" ] && run_test "$f"
    done
  done
fi
