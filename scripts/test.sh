#!/usr/bin/env bash
set -e

run_test() {
  echo "Running $1"
  node "$1"
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
