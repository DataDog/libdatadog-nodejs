#!/usr/bin/env bash
set -e

run_test() {
  local dir
  dir=$(dirname "$1")
  if [ -f "${dir}/package.json" ]; then
    echo "Installing dependencies for $1"
    yarn --cwd "$dir" install
  fi
  echo "Running $1"
  # node:test does not force the process to exit when the event loop is kept
  # active by async work that has already settled (e.g. the wasm trace
  # exporter's runtime machinery after a flush). For the long-lived real
  # consumer that is expected; for the test runner we force a clean exit once
  # all tests have finished. Only applies to files that use node:test.
  if grep -q "node:test" "$1"; then
    node --test-force-exit "$1"
  else
    node "$1"
  fi
}

# Run top-level test files
for f in test/*.js; do
  run_test "$f"
done

# Run index.js in test subdirectories (except wasm)
for d in test/*/; do
  case "$d" in
    *wasm*) ;;
    *)
      [ -f "${d}index.js" ] && run_test "${d}index.js"
      ;;
  esac
done
